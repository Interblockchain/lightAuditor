//------------------------------------------------------------------------------------------
// Library
//      validator
// Description:
//      - The library provides methods to subscribe to the various blockchains, to track
//        payments and do the bookkeeping and do financal accouting checks. It communicates
//        via posts with the Interblockchain WAMs at our Digital Ocean deployment
//        (http://174.138.50.251:6080/api/v1/subscribe).
//  Author:
//      - Paul Boulanger (paul.boulanger5@gmail.com)
//  Copyright:
//      - todo
//------------------------------------------------------------------------------------------

/* The request object:
 transactionID       : ID of the IBC transaction (we assign those?)
 sourceNetwork       : Blockchain of the source transaction (Etherium Network, Bitcoin Network, etc)
 sourceAddress       : interblockchain address in sourceNetwork where the user will send the tokens
 from                : in ETH: userAddress from which the user will send tokens (the from field in ETH tx)
                     : in BTC: the user address can be anything, the source address is the user identifyer
 destinationNetwork  : Blockchain of the destination transaction (Etherium Network, Bitcoin Network, etc)
 destinationAddress  : user address in destinationNetwork
 tokenContractAddress: Address of the smart contract defining the tokens
 requiredConf         : Number of confirmations to track
 onlyReqConf          : Do we only issue responses when requiredConf is reached
*/
const schemasObj = require("./config/schemas");
const objChecker = require('jsonschema').Validator;
const v = new objChecker();
const fs = require('fs');
const path = require('path');
const translib = new (require('translib'))();
var events = require('events');
var eventEmitter = new events.EventEmitter();
const comms = new (require("./axios.controller.js"))();
const bigNumber = require('bignumber.js');

const MongoDB = require("./config/mongoDB");
const Transfer = require('./models/transfer');
const mongoose = require('mongoose');
const { type } = require("os");

require("./config/confTable");

class Validator {
    constructor(params) {
        this.testnet = (params.testnet !== 'undefined') ? params.testnet : true;
        this._debug = (params.debug !== 'undefined') ? params.debug : false;
        this.withMongo = false;
        if (params.mongoHost) {
            this.withMongo = true
            this.mongoDB = new MongoDB(params.mongoUser, params.mongoPsw, params.mongoHost, params.mongoDB, params.mongoPort);
        }
    }

    async init() {
        await this.getNodeId();
    }

    async saveTransferRequest(workInProgress, transferRequest, fees) {
        const sourceNetwork = translib.getNetworkSymbol(transferRequest.sourceNetwork);
        const destNetwork = translib.getNetworkSymbol(transferRequest.destinationNetwork);

        // Calculate the respective amounts
        // sourceAmount = amount 
        // destAmount = amount - networkFees - incomeFees
        let bigDestAmount = (new bigNumber(transferRequest.amount)).minus(fees.incomeFee).minus(fees.networkFee).toString();
        const sourceAmount = translib.convertAmountToInteger(transferRequest.amount, transferRequest.ticker);
        const destAmount = translib.convertAmountToInteger(bigDestAmount, transferRequest.ticker);

        //Some arithmetic to construct keys
        const sourceAddress = (sourceNetwork == "TETH" || sourceNetwork == "ETH") ? transferRequest.sourceAddress.toLowerCase() : transferRequest.sourceAddress;
        const destinationAddress = (destNetwork == "TETH" || destNetwork == "ETH") ? transferRequest.destinationAddress.toLowerCase() : transferRequest.destinationAddress;
        if (sourceNetwork == "TETH" || sourceNetwork == "ETH") {
            var from = (transferRequest.from != "" && transferRequest.from != "none") ? transferRequest.from.toLowerCase() : "0";
        } else {
            var from = (transferRequest.from != "" && transferRequest.from != "none") ? transferRequest.from : "0";
        }
        const sourceKey = `${sourceNetwork}:${sourceAddress.toUpperCase()}:${from.toUpperCase()}:${sourceAmount}:${transferRequest.ticker}`;
        const destKey = `${destNetwork}:${destinationAddress.toUpperCase()}:0:${destAmount}:${transferRequest.ticker}`;

        // Save the TR in the workInProgress and mongo
        const transferInfo = {
            timestamp: translib.logTime(),
            sourceKey: sourceKey,
            destKey: destKey,
            transferRequest: transferRequest,
            sourceReqConf: confTable[sourceNetwork],
            sourceNbConf: -1,
            sourceTxHash: "",
            destinationReqConf: confTable[destNetwork],
            destinationNbConf: -1,
            destinationTxHash: "",
            sourceAmount: "",
            destinationAmount: "",
            sourceMessageID: "",
            destinationMessageID: "",
            incomeFees: fees.incomeFee,
            networkFees: fees.networkFee
        };
        workInProgress.push(transferInfo);
        if (this.withMongo) {
            const transfer = new Transfer(transferInfo);
            await transfer.save();
            console.log(`[validator:saveTransferRequest] saved : ${transferInfo.transferRequest.transactionID}`);
        }
    }

    async checkRequestDuplicate(workInProgress, transferRequest) {
        let responseObj = transferRequest;
        let validationParams = v.validate(transferRequest, schemasObj.transferRequest);
        if (!validationParams.valid) {
            responseObj.success = false;
            responseObj.errors = [];
            for (let i in validationParams.errors) {
                responseObj.errors.push(validationParams.errors[i].property + " " + validationParams.errors[i].message);
                console.log(`${translib.logTime()} [validator:checkRequestDuplicate] transferRequest validation error ${i}: ${validationParams.errors[i].property} ${validationParams.errors[i].message}`);
            }
            throw { name: `${translib.logTime()} validator, checkRequestDuplicate: validation error`, statusCode: 400, message: responseObj }
        }

        const sourceNetwork = translib.getNetworkSymbol(transferRequest.sourceNetwork);
        const destNetwork = translib.getNetworkSymbol(transferRequest.destinationNetwork);

        // Here we must get the fees to add them correctly to the amounts
        const reqBody = {
            accountID: transferRequest.accountID,
            network: destNetwork,
            currency: transferRequest.ticker,
            provider: "moveToken",
            amount: transferRequest.amount
        };
        let url = (this.testnet) ? `https://testapi.transledger.io/feeserver/fees` : `https://api.transledger.io/feeserver/fees` ;
        // console.log(`Getting fees from : ${url}, for: ${JSON.stringify(reqBody)}`);
        const fees = await comms.axiosPOST(url, reqBody, { headers: { apicode: "340f202c-fa7b-4fdc-babf-8ddc2a9f3543" } });
        if (isNaN(fees.incomeFee) || isNaN(fees.networkFee)) {
            throw { name: `${translib.logTime()} validator, saveTransferRequest: ERROR fetching fees`, statusCode: 400, message: transferRequest }
        }
        // Then we calculate the respective amounts
        // sourceAmount = amount 
        // destAmount = amount - networkFees - incomeFees
        let bigDestAmount = (new bigNumber(transferRequest.amount)).minus(fees.incomeFee).minus(fees.networkFee).toString();
        const sourceAmount = translib.convertAmountToInteger(transferRequest.amount, transferRequest.ticker);
        const destAmount = translib.convertAmountToInteger(bigDestAmount, transferRequest.ticker);

        const sourceAddress = (sourceNetwork == "TETH" || sourceNetwork == "ETH") ? transferRequest.sourceAddress.toLowerCase() : transferRequest.sourceAddress;
        const destinationAddress = (destNetwork == "TETH" || destNetwork == "ETH") ? transferRequest.destinationAddress.toLowerCase() : transferRequest.destinationAddress;
        if (sourceNetwork == "TETH" || sourceNetwork == "ETH") {
            var from = (transferRequest.from != "" && transferRequest.from != "none") ? transferRequest.from.toLowerCase() : "0";
        } else {
            var from = (transferRequest.from != "" && transferRequest.from != "none") ? transferRequest.from : "0";
        }
        const sourceKey = `${sourceNetwork}:${sourceAddress.toUpperCase()}:${from.toUpperCase()}:${sourceAmount}:${transferRequest.ticker}`;
        const destKey = `${destNetwork}:${destinationAddress.toUpperCase()}:0:${destAmount}:${transferRequest.ticker}`;

        try {
            const ssElement = workInProgress.findIndex(element => element.sourceKey === sourceKey);
            const sdElement = workInProgress.findIndex(element => element.sourceKey === destKey);
            const ddElement = workInProgress.findIndex(element => element.destKey === destKey);
            const dsElement = workInProgress.findIndex(element => element.destKey === sourceKey);
            //Checking only in workInProgress to make sure TRID is unique (should we extend this to completedTR?)
            const tridElement = workInProgress.findIndex(element => element.transferRequest.transactionID === transferRequest.transactionID);

            //Check that the request does not possess a duplicate key or TRID before doing anything
            if ((ssElement < 0) && (sdElement < 0) && (ddElement < 0) && (dsElement < 0) && (tridElement < 0)) {
                return { status: true, fees: fees }
            } else {
                return { status: false, fees: fees }
            }
        } catch (err) {
            responseObj.success = false;
            responseObj.errors = err;
            throw { name: `${translib.logTime()} validator, checkRequestDuplicate: findIndex error `, statusCode: 400, message: responseObj }
        };
    }

    checkRequestComplete(request) {
        //if (request.sourceTxHash != "" && request.destinationTxHash != "") {
        if (request.sourceNbConf >= request.sourceReqConf && request.destinationNbConf >= request.destinationReqConf) {
            return true
        } else { return false }
    }

    //Redundant, if it matched previously, that means the amounts matched too 
    //TO DO: Add additionnal tests (check amounts) when unambiguous destination
    //Use bignumber for decimals? Integrate fees?
    auditRequest(request) {
        //console.log(request.sourceAmount + " vs " + request.destinationAmount);
        // return request.sourceAmount === request.destinationAmount;
        return true;
    }

    addressInWorkInProgress(workInProgress, index, address) {
        //Loop on all elements and check if address is present
        let result = false;
        for (var i = 0, len = workInProgress.length; i < len; i++) {
            if (i != index && (workInProgress[i].transferRequest.sourceAddress === address || workInProgress[i].transferRequest.destinationAddress === address)) {
                result = true
            }
        }
        return result;
    }

    async processEvent(workInProgress, eventObj) {
        let responseObj = eventObj;
        v.addSchema(schemasObj.addresses, "/Addresses");
        let validationParams = v.validate(eventObj, schemasObj.event);
        if (!validationParams.valid) {
            responseObj.success = false;
            responseObj.errors = [];
            for (let i in validationParams.errors) {
                responseObj.errors.push(validationParams.errors[i].property + " " + validationParams.errors[i].message);
                console.log(`${translib.logTime()} [validator:processEvent] watcherEvent validation error ${i}: ${validationParams.errors[i].property} ${validationParams.errors[i].message}`);
            }
            throw { name: `${translib.logTime()} validator, processEvent: validation error`, statusCode: 400, message: responseObj }
        }

        //Test if this transaction is a source or destination transaction
        //And do the bookeeping needed
        let requestFinished = false;
        let addressTo = "";
        let amount = "";
        let from = "0";
        let address = "";
        if (eventObj.addresses.length > 1) { throw { name: "Validator: processEvent", message: "Multiple adresses in one Event not supported yet" } }
        //This works when there is only one address
        addressTo = eventObj.addresses[0].address;
        amount = eventObj.addresses[0].amount;
        if (eventObj.network.toUpperCase() == "TETH" || eventObj.network.toUpperCase() == "ETH") {
            from = (eventObj.addressFrom && eventObj.from != "none") ? eventObj.addressFrom.toLowerCase() : "0";
            address = addressTo.toLowerCase();
        } else {
            from = (eventObj.addressFrom && eventObj.from != "none") ? eventObj.addressFrom : "0";
            address = addressTo;
        }
        let key = `${eventObj.network.toUpperCase()}:${address.toUpperCase()}:${from.toUpperCase()}:${amount}:${eventObj.ticker}`;
        //console.log("Key source: " + key);
        // let element = workInProgress.findIndex(element => element.sourceKey === key);
        let element = workInProgress.findIndex(element => {
            let storedFrom = ( !element.transferRequest.from || element.transferRequest.from.toUpperCase() == "NONE") ? "0" : element.transferRequest.from.toUpperCase();
            let initTest = element.transferRequest.sourceNetwork.toUpperCase() == eventObj.network.toUpperCase() &&
                element.transferRequest.sourceAddress.toUpperCase() == address.toUpperCase() &&
                storedFrom == from.toUpperCase() &&
                element.transferRequest.ticker.toUpperCase() == eventObj.ticker;
            if(initTest) {
                let diff = Math.abs(parseInt(amount) - parseInt(translib.convertAmountToInteger(element.transferRequest.amount, element.transferRequest.ticker)));
                return diff <= parseInt(amount)*0.01   // 1% fluctuations
            } else {
                return false;
            }
        });
        if (element >= 0) {
            console.log(`${translib.logTime()} [validator:processEvent] Received source transaction for TRID: ${workInProgress[element].transferRequest.transactionID}`);
            let transferObj = await Transfer.findOne({ "transferRequest.transactionID": workInProgress[element].transferRequest.transactionID });
            if (workInProgress[element].sourceTxHash === "") {
                workInProgress[element].sourceTxHash = eventObj.txHash;
                workInProgress[element].sourceAmount = eventObj.addresses[0].amount;
                workInProgress[element].sourceMessageID = eventObj.messageID;
                if (this.withMongo) {
                    transferObj["sourceTxHash"] = eventObj.txHash;
                    transferObj["sourceAmount"] = eventObj.addresses[0].amount;
                    transferObj["sourceMessageID"] = eventObj.messageID;
                }
            }
            if (eventObj.nbConf < workInProgress[element].sourceNbConf) {
                throw { name: "Validator: processEvent", message: "sourceNbConf decreased!" }
            }
            workInProgress[element].sourceNbConf = eventObj.nbConf;
            if (this.withMongo) {
                transferObj["sourceNbConf"] = eventObj.nbConf;
                const transfer = new Transfer(transferObj);
                await transfer.save();
            }

            requestFinished = this.checkRequestComplete(workInProgress[element]);

            this._debug ? console.log(`${translib.logTime()} [validator:processEvent] Request ${workInProgress[element].transferRequest.transactionID} finished? ${requestFinished}`) : null;
            if (requestFinished) {
                let requestAudited = this.auditRequest(workInProgress[element]);
                if (requestAudited) {
                    requestFinished = false;
                } else {
                    console.log(`${translib.logTime()} [validator:processEvent] Audit Failed, amounts do not match!`);
                }
                let auditDetails = {
                    auditorID: this.nodeId,
                    status: requestAudited,
                    TR: workInProgress[element]
                };
                eventEmitter.emit('audit', auditDetails);
                return element;
            }
        } else {
            key = `${eventObj.network.toUpperCase()}:${address.toUpperCase()}:0:${amount}:${eventObj.ticker}`;
            //console.log("Key dest: " + key);
            // element = workInProgress.findIndex(element => element.destKey === key);
            element = workInProgress.findIndex(element => {
                let initTest = element.transferRequest.destinationNetwork.toUpperCase() == eventObj.network.toUpperCase() &&
                    element.transferRequest.destinationAddress.toUpperCase() == address.toUpperCase() &&
                    element.transferRequest.ticker.toUpperCase() == eventObj.ticker;
                if(initTest) {
                    let bigDestAmount = (new bigNumber(element.transferRequest.amount)).minus(element.incomeFees).minus(element.networkFees).toString();
                    let diff = Math.abs(parseInt(amount) - parseInt(translib.convertAmountToInteger(bigDestAmount, element.transferRequest.ticker)));
                    return diff <= parseInt(amount)*0.01   // 1% fluctuations
                } else {
                    return false;
                }
            });
            if (element >= 0) {
                console.log(`${translib.logTime()} [validator:processEvent] Received a destination transaction for TRID: ${workInProgress[element].transferRequest.transactionID}`);
                let transferObj = await Transfer.findOne({ "transferRequest.transactionID": workInProgress[element].transferRequest.transactionID });
                if (workInProgress[element].destinationTxHash === "") {
                    workInProgress[element].destinationTxHash = eventObj.txHash;
                    workInProgress[element].destinationAmount = eventObj.addresses[0].amount.toString();
                    workInProgress[element].destinationMessageID = eventObj.messageID;
                    if (this.withMongo) {
                        transferObj["destinationTxHash"] = eventObj.txHash;
                        transferObj["destinationAmount"] = eventObj.addresses[0].amount;
                        transferObj["destinationMessageID"] = eventObj.messageID;
                    }
                }
                if (eventObj.nbConf < workInProgress[element].destinationNbConf) {
                    throw { name: "Validator: processEvent", message: "destinationNbConf decreased!" }
                }
                workInProgress[element].destinationNbConf = eventObj.nbConf;
                if (this.withMongo) {
                    transferObj["destinationNbConf"] = eventObj.nbConf;
                    const transfer = new Transfer(transferObj);
                    await transfer.save();
                }
                requestFinished = this.checkRequestComplete(workInProgress[element]);
                this._debug ? console.log(`${translib.logTime()} [validator:processEvent] Request ${workInProgress[element].transferRequest.transactionID} finished? ${requestFinished}`) : null;
                if (requestFinished) {
                    let requestAudited = this.auditRequest(workInProgress[element]);
                    if (requestAudited) {
                        requestFinished = false;
                    } else {
                        console.log(`${translib.logTime()} [validator:processEvent] Audit Failed, amounts do not match!`);
                    }
                    let auditDetails = {
                        auditorID: this.nodeId,
                        status: requestAudited,
                        TR: workInProgress[element]
                    };
                    // console.log("Emitting event audit");
                    eventEmitter.emit('audit', auditDetails);
                    return element
                }
            } else {
                console.log(`${translib.logTime()} [validator:processEvent] Received transaction not associated with any Request.`);
            }
        }
        return -1;
    }

    async getNodeId() {
        let file = path.join(__dirname, 'nodeId.txt');
        try {
            fs.accessSync(file, fs.constants.F_OK)
            // File exists
            this.nodeId = await fs.readFileSync(file, 'utf8');
            //console.log("Read: " + this.nodeId);
        } catch (err) {
            // File does not exist
            this.nodeId = `validator-${translib.uuidv4()}`;
            fs.writeFileSync(file, this.nodeId);
            //console.log("Generating nodeId: " + this.nodeId);
        }
    }

    async checkAddress(network, address, currency) {
        // Check if address is valid. The criteria are:
        // For UTXO + ETH: formatted correctly
        // For XLM: existence and does it trust the valid token:issuer
        // For XRP and EOSIO: existence only



    }
}

module.exports = {
    validator: Validator,
    nodeID: this.nodeId,
    eventEmitter: eventEmitter
};