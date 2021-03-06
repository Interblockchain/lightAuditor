const translib = new(require('translib'))();

class garbageCollector {

    constructor(eventEmitter, validator) {
        this._eventEmitter = eventEmitter;
        this._validator = validator;
    }

    async globalTimeout(workInProgress, timedOut, completedTR, confTable, WSM) {
        setInterval(async () => {
            workInProgress.forEach(async (element, index) => {
                let elapsed = Date.now() - Date.parse(element.timestamp);
                if (elapsed > 48 * 60 * 60 * 1000) {
                    console.log(`${translib.logTime()} [garbageCollector] Global Timeout for TRID: ${element.transferRequest.transactionID}`);
                    timedOut.push({ timestamp: Date.now(), TR: element });
                    let presentSource = await this._validator.addressInWorkInProgress(workInProgress, index, element.transferRequest.sourceAddress);
                    let presentDest = await this._validator.addressInWorkInProgress(workInProgress, index, element.transferRequest.destinationAddress);
                    let sourNet = translib.getNetworkSymbol(element.transferRequest.sourceNetwork);
                    let destNet = translib.getNetworkSymbol(element.transferRequest.destinationNetwork);
                    await WSM.sendActionToAugmentedNode(element.transferRequest, confTable, sourNet, destNet,  "unsubscribe", !presentSource, !presentDest);
                    let auditDetails ={
                        status: false,
                        TR: workInProgress[index]
                    };
                    this._eventEmitter.emit('audit', auditDetails);
                    workInProgress.splice(index, 1);
                }
            });

            timedOut.forEach((element, index) => {
                let elapsed = Date.now() - Date.parse(element.timestamp);
                if (elapsed > 48 * 60 * 60 * 1000) {
                    timedOut.splice(index, 1);
                }
            });

            completedTR.forEach((element, index) => {
                let elapsed = Date.now() - Date.parse(element.timestamp);
                if (elapsed > 48 * 60 * 60 * 1000) {
                    completedTR.splice(index, 1);
                }
            });
        }, 5 * 60 * 1000);
    }
    async paymentTimeout(workInProgress, timedOut, confTable, WSM) {
        setInterval(async () => {
            workInProgress.forEach(async (element, index) => {
                let elapsed = Date.now() - Date.parse(element.timestamp);
                if (elapsed > 10 * 60 * 1000 && element.sourceTxHash === "") {
                    console.log(`${translib.logTime()} [garbageCollector] Timeout on payment for TRID: ${element.transferRequest.transactionID}`);
                    timedOut.push({ timestamp: Date.now(), TR: element });
                    let presentSource = await this._validator.addressInWorkInProgress(workInProgress, index, element.transferRequest.sourceAddress);
                    let presentDest = await this._validator.addressInWorkInProgress(workInProgress, index, element.transferRequest.destinationAddress);
                    let sourNet = translib.getNetworkSymbol(element.transferRequest.sourceNetwork);
                    let destNet = translib.getNetworkSymbol(element.transferRequest.destinationNetwork);
                    await WSM.sendActionToAugmentedNode(element.transferRequest, confTable, sourNet, destNet,  "unsubscribe", !presentSource, !presentDest);
                    let auditDetails ={
                        status: false,
                        TR: workInProgress[index]
                    };
                    this._eventEmitter.emit('audit', auditDetails);
                    workInProgress.splice(index, 1);
                }
            });
        }, 15 * 1000);
    }
}

module.exports = garbageCollector;