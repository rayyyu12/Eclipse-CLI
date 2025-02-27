"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.prepareJitoTip = prepareJitoTip;
exports.sendJitoTransaction = sendJitoTransaction;
exports.updateTransactionWithJitoTip = updateTransactionWithJitoTip;
//jito.ts
const web3_js_1 = require("@solana/web3.js");
const settingsManager_1 = require("../../cli/utils/settingsManager");
const JITO_TIP_ACCOUNTS = [
    "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
    "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
    "Cw8CFyM9FkoMi7K7Crf6HNQqf1uEMzpKw6QNghXLvLkY",
    "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
    "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
    "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
    "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
    "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT"
];
// Cache for tip floor data
let cachedTipInfo = {
    data: null,
    timestamp: 0
};
// Cache duration in milliseconds (30 seconds)
const TIP_CACHE_DURATION = 30000;
async function getJitoTipFloor() {
    try {
        if (cachedTipInfo.data &&
            Date.now() - cachedTipInfo.timestamp < TIP_CACHE_DURATION) {
            return cachedTipInfo.data;
        }
        const response = await fetch('https://bundles.jito.wtf/api/v1/bundles/tip_floor', {
            headers: {
                'Accept': 'application/json'
            }
        });
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const data = await response.json();
        if (!Array.isArray(data) || data.length === 0) {
            throw new Error('Invalid tip floor data format');
        }
        cachedTipInfo = {
            data: data[0],
            timestamp: Date.now()
        };
        return data[0];
    }
    catch (error) {
        return null;
    }
}
async function prepareJitoTip(priorityFee, payerPubkey, silent = false) {
    const settings = settingsManager_1.SettingsManager.getInstance().getSettings();
    let tipAmount;
    if (!settings.fees.useAutomaticJitoTip && settings.fees.fixedJitoTipAmount) {
        // Convert SOL to lamports, ensure minimum of 1000 lamports
        const minimumTip = 1000;
        tipAmount = Math.max(Math.floor(settings.fees.fixedJitoTipAmount * web3_js_1.LAMPORTS_PER_SOL), minimumTip);
    }
    else {
        tipAmount = await calculateOptimalJitoTip(priorityFee, settings.fees.jitoTipAggressiveness, silent);
    }
    const tipAccountIndex = Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length);
    if (!silent) {
    }
    return web3_js_1.SystemProgram.transfer({
        fromPubkey: payerPubkey,
        toPubkey: new web3_js_1.PublicKey(JITO_TIP_ACCOUNTS[tipAccountIndex]),
        lamports: tipAmount
    });
}
async function calculateOptimalJitoTip(priorityFee, aggressiveness = 'medium', silent = false) {
    try {
        const tipInfo = await getJitoTipFloor();
        if (!tipInfo) {
            return Math.floor(priorityFee * 0.3);
        }
        const tips = {
            p25: Math.floor(tipInfo.landed_tips_25th_percentile * web3_js_1.LAMPORTS_PER_SOL),
            p50: Math.floor(tipInfo.landed_tips_50th_percentile * web3_js_1.LAMPORTS_PER_SOL),
            p75: Math.floor(tipInfo.landed_tips_75th_percentile * web3_js_1.LAMPORTS_PER_SOL),
            p95: Math.floor(tipInfo.landed_tips_95th_percentile * web3_js_1.LAMPORTS_PER_SOL)
        };
        let baseTip;
        switch (aggressiveness) {
            case 'low':
                baseTip = Math.max(tips.p25, 1000);
                break;
            case 'high':
                baseTip = Math.max(tips.p95, 1000);
                break;
            default:
                baseTip = Math.max(tips.p75, 1000);
        }
        return Math.max(baseTip, Math.floor(priorityFee * 0.3));
    }
    catch (error) {
        return Math.max(Math.floor(priorityFee * 0.3), 1000);
    }
}
async function sendJitoTransaction(transaction, options = { skipPreflight: true, bundleOnly: true }) {
    const serializedTx = transaction.serialize();
    const base64Tx = Buffer.from(serializedTx).toString('base64');
    const response = await fetch('https://mainnet.block-engine.jito.wtf/api/v1/transactions', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'sendTransaction',
            params: [
                base64Tx,
                {
                    encoding: 'base64',
                    skipPreflight: options.skipPreflight ?? true,
                    bundleOnly: options.bundleOnly ?? true
                }
            ]
        })
    });
    const data = await response.json();
    if ('error' in data) {
        throw new Error(`Jito API error: ${JSON.stringify(data.error)}`);
    }
    // Get bundle ID from header if available
    const bundleId = response.headers.get('x-bundle-id');
    if (bundleId && !data.error) {
    }
    return data.result;
}
function updateTransactionWithJitoTip(transaction, tipAmount, signer) {
    const payerPubkey = transaction.message.staticAccountKeys[0];
    const tipAccountIndex = Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length);
    const tipInstruction = web3_js_1.SystemProgram.transfer({
        fromPubkey: payerPubkey,
        toPubkey: new web3_js_1.PublicKey(JITO_TIP_ACCOUNTS[tipAccountIndex]),
        lamports: tipAmount
    });
    const originalInstructions = transaction.message.compiledInstructions.map((compiled) => ({
        programId: transaction.message.staticAccountKeys[compiled.programIdIndex],
        keys: compiled.accountKeyIndexes.map(index => ({
            pubkey: transaction.message.staticAccountKeys[index],
            isSigner: transaction.message.isAccountSigner(index),
            isWritable: transaction.message.isAccountWritable(index)
        })),
        data: Buffer.from(compiled.data)
    }));
    const messageV0 = new web3_js_1.TransactionMessage({
        payerKey: payerPubkey,
        recentBlockhash: transaction.message.recentBlockhash,
        instructions: [
            originalInstructions[0],
            tipInstruction,
            ...originalInstructions.slice(2)
        ]
    }).compileToV0Message();
    const updatedTransaction = new web3_js_1.VersionedTransaction(messageV0);
    updatedTransaction.sign([signer]);
    return updatedTransaction;
}
