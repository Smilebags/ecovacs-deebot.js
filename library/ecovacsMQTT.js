'use strict';

const Ecovacs = require('./ecovacs');
const tools = require('./tools');
const constants = require('./constants');
const axios = require("axios").default;

class EcovacsMQTT extends Ecovacs {
    /**
     * @param {Object} vacBot - the VacBot object
     * @param {string} user - the userId retrieved by the Ecovacs API
     * @param {string} hostname - the hostname of the API endpoint
     * @param {string} resource - the resource of the vacuum
     * @param {string} secret - the user access token
     * @param {string} continent - the continent where the Ecovacs account is registered
     * @param {string} country - the country where the Ecovacs account is registered
     * @param {Object} vacuum - the device object for the vacuum
     * @param {string} serverAddress - the address of the MQTT server
     * @param {number} [serverPort=8883] - the port that the MQTT server is listening on
     */
    constructor(vacBot, user, hostname, resource, secret, continent, country, vacuum, serverAddress, serverPort = 8883) {
        super(vacBot, user, hostname, resource, secret, continent, country, vacuum, serverAddress, serverPort);

        this.mqtt = require('mqtt');
        // MQTT is using domain without tld extension
        const customDomain = hostname.split(".")[0];
        this.username = user + '@' + customDomain;

        // The payload type is either 'x' (XML) or 'j' (JSON)
        this.payloadType = '';
    }

    /**
     * Subscribe for "broadcast" messages to the MQTT channel
     * @see https://deebot.readthedocs.io/advanced/protocols/mqtt/#mqtt
     */
    subscribe() {
        const channel = `iot/atr/+/${this.vacuum['did']}/${this.vacuum['class']}/${this.vacuum['resource']}/${this.payloadType}`;
        console.log(channel);
        this.client.subscribe(channel, (error, granted) => {
            if (!error) {
                tools.envLog('[EcovacsMQTT] Subscribed to atr channel');
                this.emit('ready', 'Client connected. Subscribe successful');
            } else {
                tools.envLog('[EcovacsMQTT] Subscribe err: %s', error.toString());
            }
        });
    }

    /**
     * Connect to the MQTT server and listen to broadcast messages
     */
    connect() {
        let url = `mqtts://${this.serverAddress}:${this.serverPort}`;
        tools.envLog("[EcovacsMQTT] Connecting as %s to %s", this.username, url);
        this.client = this.mqtt.connect(url, {
            clientId: this.username + '/' + this.resource,
            username: this.username,
            password: this.secret,
            protocolVersion: 4,
            keepalive: 120,
            rejectUnauthorized: false
        });

        let ecovacsMQTT = this;

        this.client.on('connect', function () {
            tools.envLog('[EcovacsMQTT] client connected');
            ecovacsMQTT.subscribe();
        });

        this.client.on('message', (topic, message) => {
            this.handleMessage(topic, message.toString(), "incoming");
        });

        this.client.on('offline', function () {
            try {
                ecovacsMQTT.emitNetworkError('MQTT server is offline or not reachable');
            } catch (e) {
                tools.envLog('[EcovacsMQTT] MQTT server is offline or not reachable');
            }
        });

        this.client.on('disconnect', function (packet) {
            try {
                ecovacsMQTT.emitNetworkError('MQTT client received disconnect event');
            } catch (e) {
                tools.envLog('[EcovacsMQTT] MQTT client received disconnect event');
            }
        });

        this.client.on('error', (error) => {
            try {
                ecovacsMQTT.emitNetworkError(`MQTT client error: ${error.message}`);
            } catch (e) {
                tools.envLog(`MQTT client error: ${error.message}`);
            }
        });

        this.on("ready", (event) => {
            tools.envLog('[EcovacsMQTT] Received ready event');
        });
    }

    /**
     * @param {Object} command - the command object
     * @param {Object} params
     */
    getRequestUrl(command,params) {
        const apiPath = this.getApiPath(command);
        let portalUrlFormat = constants.PORTAL_ECOUSER_API;
        if (this.country === 'CN') {
            portalUrlFormat = constants.PORTAL_ECOUSER_API_CN;
        }
        let portalUrl = tools.formatString(portalUrlFormat + '/' + apiPath, {continent: this.continent});
        if (this.bot.is950type()) {
            if (this.bot.authDomain === constants.AUTH_DOMAIN_YD) {
                portalUrl = portalUrl + "?cv=1.94.76&t=a&av=1.3.0"; // yeedi
            } else {
                portalUrl = portalUrl + "?cv=1.94.78&t=a&av=2.2.4"; // Ecovacs
            }
            if (apiPath === constants.IOT_DEVMANAGER_PATH) {
                portalUrl = portalUrl + "&mid=" + params['toType'] + "&did=" + params['toId'] + "&td=" + params['td'] + "&u=" + params['auth']['userid'];
            }
        }
        return portalUrl;
    }

    getRequestHeaders(params) {
        let headers = {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(JSON.stringify(params))
        };
        if (this.bot.is950type()) {
            Object.assign(headers, {
                'User-Agent': 'Dalvik/2.1.0 (Linux; U; Android 5.1.1; A5010 Build/LMY48Z)'
            });
        }
        return headers;
    }

    /**
     * The function returns the request object
     * @param {Object} command - the action to be performed
     * @returns {Object} the command object used to be sent
     */
    getRequestObject(command) {
        if (command.name === 'GetCleanLogs') {
            return this.getCleanLogsCommandObject(command);
        }
        else {
            const payload = this.getCommandPayload(command);
            return this.getCommandRequestObject(command, payload);
        }
    }

    /**
     * @param {Object} command - the command object
     * @returns {string|object} the specific payload for the request object
     * @abstract
     */
    getCommandPayload(command) { return ''; }

    /**
     * @param {Object} command - the command that was sent to the Ecovacs API
     * @param {Object} messagePayload - The message payload that was received
     * @abstract
     */
    handleCommandResponse(command, messagePayload) {}

    /**
     * @param {string} topic - the topic of the message
     * @param {Object|string} message - the message
     * @param {string} [type=incoming] the type of message. Can be "incoming" (MQTT message) or "response"
     * @abstract
     */
    handleMessage(topic, message, type = "incoming") {}

    /**
     * It sends a command to the Ecovacs API
     * @param {Object} command - the command to send to the Ecovacs API
     * @returns {Promise<void>}
     */
    async sendCommand(command) {
        try {
            const params = this.getRequestObject(command);
            const portalUrl = this.getRequestUrl(command, params);
            const headers = this.getRequestHeaders(params);
            let response;
            try {
                const res = await axios.post(portalUrl, params, {
                    headers: headers
                });
                response = res.data;
                tools.envLog("[EcovacsMQTT] got %s", JSON.stringify(response));
            } catch (e) {
                this.emitNetworkError(e.message, command.name);
                throw e.message;
            }

            if ((response['result'] === 'ok') || (response['ret'] === 'ok')) {
                if (this.bot.errorCode !== '0') {
                    this.emitLastErrorByErrorCode('0');
                }
                this.handleCommandResponse(command, response);
            } else {
                const errorCodeObj = {
                    code: response['errno'],
                    error: response['error']
                };
                this.bot.handleResponseError(errorCodeObj);
                // Error code 500 = wait for response timed out (see issue #19)
                if (this.bot.errorCode === '500') {
                    this.bot.errorDescription = this.bot.errorDescription + ` (command '${command.name}')`;
                }
                if ((this.bot.errorCode !== '500') || !tools.is710series(this.bot.deviceClass)) {
                    this.emitLastError();
                }
                tools.envLog(`[EcovacsMQTT] failure code ${response['errno']} (${response['error']}) sending command '${command.name}'`);
                throw `Failure code ${response['errno']} (${response['error']})`;
            }
        } catch (e) {
            tools.envLog("[EcovacsMQTT] Error making call to Ecovacs API: " + e.toString());
        }
    }

    /**
     * This function is used to determine the API to use for the action
     * @param {Object} command - the command object
     * @returns {string} the API path that has to be called
     */
    getApiPath(command) {
        let api = constants.IOT_DEVMANAGER_PATH; // non 950 type models
        if (command.name === 'GetCleanLogs') {
            api = constants.CLEANLOGS_PATH; // Cleaning log for non 950 type models (MQTT/XML)
        } else if (command.api) {
            api = command.api; // 950 type models
        }
        return api;
    }

    /**
     * This function returns a standard request object for sending commands
     * @param {Object} command - the command object
     * @param {Object} payload - the payload object
     * @returns {Object} the JSON object
     */
    getCommandRequestObject(command, payload) {
        return {
            'cmdName': command.name,
            'payload': payload,
            'payloadType': this.payloadType,
            'auth': this.getAuthObject(),
            'td': 'q',
            'toId': this.vacuum['did'],
            'toRes': this.vacuum['resource'],
            'toType': this.vacuum['class']
        };
    }

    /**
     * Returns a request object for receiving clean logs
     * @param {Object} command - the command object
     * @returns {Object} the JSON object
     */
    getCleanLogsCommandObject(command) {
        return {
            'auth': this.getAuthObject(),
            'did': this.vacuum['did'],
            'country': this.country,
            'td': command.name,
            'resource': this.vacuum['resource']
        };
    }

    /**
     * Returns the `auth` object used for the command object
     * @returns {Object} the JSON object
     */
    getAuthObject() {
        return {
            'realm': constants.REALM,
            'resource': this.resource,
            'token': this.secret,
            'userid': this.user,
            'with': 'users',
        };
    }

    /**
     * Disconnect the MQTT client
     */
    disconnect() {
        tools.envLog("[EcovacsMQTT] Closing MQTT Client...");
        try {
            this.client.end();
            tools.envLog("[EcovacsMQTT] Closed MQTT Client");
        } catch(e) {
            tools.envLog("[EcovacsMQTT] Error closing MQTT Client:  %s", e.toString());
        }
    }
}

module.exports = EcovacsMQTT;
