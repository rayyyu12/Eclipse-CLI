"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getPriorityFeeEstimate = getPriorityFeeEstimate;
async function getPriorityFeeEstimate(connection, transaction) {
    try {
        const response = await fetch(connection.rpcEndpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 'helius',
                method: 'getPriorityFeeEstimate',
                params: [{
                        transaction: transaction.serialize(),
                        options: {
                            priorityLevel: "HIGH",
                            includeLogs: false
                        }
                    }]
            })
        });
        const { result } = await response.json();
        return result.priorityFeeEstimate;
    }
    catch (error) {
        console.error("Error getting priority fee estimate:", error);
        return 1000000; // fallback to 1000000 microLamports
    }
}
