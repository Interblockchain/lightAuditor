const Validator = require("./validator.js").validator;
const auditEvent = require('./validator.js').eventEmitter;
const validator = new Validator();
const WebSocketManagement = require('wsmanagement').WS;
const ANevent = require('wsmanagement').eventEmitter;
const GarbageCollector = require('./GarbageCollector');
const garbageCollector = new GarbageCollector(auditEvent);
const Broadcaster = require('ntrnetwork').Broadcaster;
const MESSAGE_CODES = require('ntrnetwork').MESSAGE_CODES;
require("./config/confTable");

class liteAuditor {
    constructor(ntrchannel, _url, _apiKey, _workInProgress, _timedOut, _completedTR) {
        this.url = _url;
        this.apiKey = _apiKey;
        this.workInProgress = _workInProgress ? _workInProgress : [];
        this.timedOut = _timedOut ? _timedOut : [];
        this.completedTR = _completedTR ? _completedTR : [];
        this.broadcaster = new Broadcaster(ntrchannel);

    }

    auditNetwork() {
        validator.init()
            .then(() => {
                // Reconnecting Websocket connections to the Watchers
                try {
                    this.WSM = new WebSocketManagement(this.url, this.apiKey, validator.nodeId);
                    this.WSM.connectAugmentedNodeWS();

                    var processResponse = (response) => {
                        console.log("Entering Response:");
                        console.log(response);
                        validator.processEvent(this.workInProgress, response)
                            .then(async (element) => {
                                console.log("Element: " + element);
                                if (element >= 0) {
                                    this.completedTR.push(this.workInProgress[element]);
                                    let presentSource = await validator.addressInWorkInProgress(this.workInProgress, element, this.workInProgress[element].transferRequest.sourceAddress);
                                    let presentDest = await validator.addressInWorkInProgress(this.workInProgress, element, this.workInProgress[element].transferRequest.destinationAddress);
                                    let sourNet = validator.getNetworkSymbol(this.workInProgress[element].transferRequest.sourceNetwork);
                                    let destNet = validator.getNetworkSymbol(this.workInProgress[element].transferRequest.destinationNetwork);
                                    await this.WSM.sendActionToAugmentedNode(this.workInProgress[element].transferRequest, confTable, sourNet, destNet, "unsubscribe", !presentSource, !presentDest);
                                    this.workInProgress.splice(element, 1);
                                }
                            })
                            .catch((error) => {
                                console.log("Error: wsan message " + error.name + " " + error.message);
                            });

                    }

                    ANevent.addListener('response', processResponse);
                    garbageCollector.globalTimeout(this.workInProgress, this.timedOut, this.completedTR, validator.nodeId, this.WSM);
                    garbageCollector.paymentTimeout(this.workInProgress, this.timedOut, validator.nodeId, this.WSM);
                } catch (error) {
                    console.log("Error with WS or garbage collection: " + error.name + " " + error.message);
                }

                // Receive the transactions on the network 
                this.broadcaster.subscribe(async (message_code, transaction) => {
                    console.log("Received Event");
                    console.log(transaction);
                    if (message_code === MESSAGE_CODES.TX) {
                        try {
                            let notDuplicate = await validator.checkRequestDuplicate(this.workInProgress, transaction)
                            if (notDuplicate) {
                                let sourNet = validator.getNetworkSymbol(transaction.sourceNetwork);
                                let destNet = validator.getNetworkSymbol(transaction.destinationNetwork);
                                await this.WSM.sendActionToAugmentedNode(transaction, confTable, sourNet, destNet, "subscribe", validator.nodeId, true, true)
                                validator.saveTransferRequest(this.workInProgress, transaction);
                            } else { console.log("Transfer Request is a duplicate!") }
                        } catch (error) {
                            console.log("Error: " + error.name + " " + error.message);
                        }
                    }
                    if (message_code === MESSAGE_CODES.AUDIT) {
                        try {
                            console.log("Received Audit");
                            //console.log(transaction);
                            //auditEvent.emit('ntraudit', transaction);
                        } catch (error) {
                            console.log("Error: " + error.name + " " + error.message);
                        }
                    }
                });
            });
    }

    async processRequest(request) {
        let response = {};
        let notDuplicate = await validator.checkRequestDuplicate(this.workInProgress, request);
        if (notDuplicate) {
            validator.saveTransferRequest(this.workInProgress, request);
            // Broadcast and process the transferRequest to all neighbour nodes
            this.broadcaster.publish(MESSAGE_CODES.TX, request);
            request.brdcTender = true;
            //Save transferRequest in Redis for restart
            // validator.redisStoreTransferRequest(request)
            request.onlyReqConf = true;
            let sourNet = validator.getNetworkSymbol(request.sourceNetwork);
            let destNet = validator.getNetworkSymbol(request.destinationNetwork);
            await this.WSM.sendActionToAugmentedNode(request, confTable, sourNet, destNet, "subscribe", true, true)
            response.status = 200;
            response.message = "Transfer request succesfully treated";
            // } else {
            //     await validator.subscribeToEvents(request)
            //         .then(() => {
            //             response.status = 200;
            //             response.message = "Transfer request succesfully treated and sent using REST";
            //             validator.saveTransferRequest(this.workInProgress, request);
            //         })
            //         .catch((error) => {
            //             console.log("Error: " + error.name + " " + error.message);
            //             let statusCode = (error.statusCode) ? error.statusCode : 500;
            //             response.status = statusCode;
            //             response.message = error.name;
            //         });
            // }
        } else {
            console.log("Transfer Request already accounted for in workInProgress.");
            response.status = 400;
            response.message = `${Date().toString().substring(0, 24)} Transfer Request already in workInProgress`;
        }
        return response;
    }

    async processReply(reply) {
        console.log("Received Reply");
        console.log("api: " + JSON.stringify(reply, null, 2));
        let response = {};
        await validator.processEvent(this.workInProgress, reply)
            .then(async (element) => {
                response.status = 200;
                response.message = "Reply succesful!";
                if (element >= 0) {
                    this.completedTR.push(this.workInProgress[element]);
                    let presentSource = await validator.addressInWorkInProgress(this.workInProgress, element, this.workInProgress[element].transferRequest.sourceAddress);
                    let presentDest = await validator.addressInWorkInProgress(this.workInProgress, element, this.workInProgress[element].transferRequest.destinationAddress);
                    let sourNet = validator.getNetworkSymbol(this.workInProgress[element].transferRequest.sourceNetwork);
                    let destNet = validator.getNetworkSymbol(this.workInProgress[element].transferRequest.destinationNetwork);
                    await WSM.sendActionToAugmentedNode(this.workInProgress[element], confTable, sourNet, destNet, "unsubscribe", !presentSource, !presentDest);
                    this.workInProgress.splice(element, 1);
                    // } else {
                    //     //Unsubscribe to the WAS
                    //     validator.unsubscribeToEvents(this.workInProgress, element)
                    //         .then(() => {
                    //             //Then delete the request from the workInProgress and set the boolean to false
                    //             this.workInProgress.splice(element, 1);
                    //             //delete it from redis storage
                    //             // this.redisDeleteTransferRequest(this.workInProgress[element].transferRequest);
                    //         });
                    // }
                }
                return response;
            })
            .catch((error) => {
                console.log("Error: " + error.name + " " + error.message);
                let statusCode = (error.statusCode) ? error.statusCode : 500;
                let errorObj = error.message;
                errorObj.error = error.name;
                response.status = statusCode
                response.message = error.name;
                return response;
            });
    }

    get state() {
        let _state = {
            workInProgress: this.workInProgress,
            timedOut: this.timedOut,
            completedTR: this.completedTR
        };
        return _state;
    }

    get ANWS() {
        return this.WSM
    }
}

module.exports = {
    auditor: liteAuditor,
    eventEmitter: auditEvent,
    validator: validator
};