"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RAYDIUM_AMM_PROGRAM_ID = exports.RENT = exports.SYSTEM_PROGRAM_ID = exports.PUMP_FUN_ACCOUNT = exports.FEE_RECIPIENT = exports.GLOBAL = exports.PUMP_FUN_PROGRAM_ID = void 0;
//constants.ts
const web3_js_1 = require("@solana/web3.js");
exports.PUMP_FUN_PROGRAM_ID = new web3_js_1.PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
exports.GLOBAL = new web3_js_1.PublicKey("4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf");
exports.FEE_RECIPIENT = new web3_js_1.PublicKey("CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM");
exports.PUMP_FUN_ACCOUNT = new web3_js_1.PublicKey("Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1");
exports.SYSTEM_PROGRAM_ID = web3_js_1.SystemProgram.programId;
exports.RENT = new web3_js_1.PublicKey("SysvarRent111111111111111111111111111111111");
exports.RAYDIUM_AMM_PROGRAM_ID = new web3_js_1.PublicKey("675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8");
