"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.validateSolAmount = validateSolAmount;
exports.validatePublicKey = validatePublicKey;
exports.validatePercentage = validatePercentage;
// src/cli/utils/validation.ts
const web3_js_1 = require("@solana/web3.js");
const config_1 = require("../config");
function validateSolAmount(amount) {
    const num = parseFloat(amount);
    return !isNaN(num) && num > config_1.CONFIG.MIN_SOL_AMOUNT && num < config_1.CONFIG.MAX_SOL_AMOUNT;
}
function validatePublicKey(address) {
    try {
        new web3_js_1.PublicKey(address);
        return true;
    }
    catch {
        return false;
    }
}
function validatePercentage(value) {
    const num = parseFloat(value);
    return !isNaN(num) && num > 0 && num <= 100;
}
