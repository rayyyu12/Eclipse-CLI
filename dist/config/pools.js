"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TOKENS = void 0;
// config/pools.ts
const web3_js_1 = require("@solana/web3.js");
exports.TOKENS = {
    SOL: {
        mint: new web3_js_1.PublicKey("So11111111111111111111111111111111111111112"),
        decimals: 9
    },
    // Remove hardcoded USDC, make it dynamic
};
