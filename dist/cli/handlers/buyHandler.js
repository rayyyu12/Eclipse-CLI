"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleBuy = handleBuy;
//buyHandler.ts
const web3_js_1 = require("@solana/web3.js");
const index_1 = require("../../index");
const regularSwap_1 = require("../../utils/swaps/regularSwap");
const pumpSwap_1 = require("../../utils/swaps/pumpSwap");
const validation_1 = require("../utils/validation");
const formatting_1 = require("../utils/formatting");
const chalk_1 = __importDefault(require("chalk"));
const blockhashManager_1 = require("../../utils/swaps/blockhashManager");
const config_1 = require("../config");
async function handleBuy() {
    try {
        const tokenAddress = await (0, formatting_1.promptWithValidation)(chalk_1.default.hex(config_1.COLORS.PRIMARY)('Enter token address: '), validation_1.validatePublicKey, 'Invalid token address format!');
        const solAmount = await (0, formatting_1.promptWithValidation)((chalk_1.default.hex(config_1.COLORS.PRIMARY)('Enter SOL amount: ')), validation_1.validateSolAmount, 'Invalid SOL amount! Please enter a positive number.');
        const tokenPublicKey = new web3_js_1.PublicKey(tokenAddress);
        formatting_1.spinner.start('Checking token type...');
        const { connection, wallet } = await (0, index_1.setupConnection)();
        // Initialize BlockhashManager before any swap operations
        blockhashManager_1.BlockhashManager.getInstance().initialize(connection);
        // Check if it's a pump.fun token
        let tokenInfo;
        try {
            tokenInfo = await (0, pumpSwap_1.isPumpFunToken)(connection, tokenPublicKey);
        }
        catch (error) {
            blockhashManager_1.BlockhashManager.getInstance().cleanup(); // Cleanup on error
            (0, formatting_1.displayError)('Failed to check token type', error);
            return;
        }
        const amount = parseFloat(solAmount);
        // Add additional validation before swap
        const solBalance = await connection.getBalance(wallet.publicKey);
        if (solBalance < amount * web3_js_1.LAMPORTS_PER_SOL + 0.01 * web3_js_1.LAMPORTS_PER_SOL) {
            blockhashManager_1.BlockhashManager.getInstance().cleanup(); // Cleanup on validation failure
            (0, formatting_1.displayError)('Insufficient SOL balance', new Error(`Need ${amount + 0.01} SOL, but only have ${solBalance / web3_js_1.LAMPORTS_PER_SOL} SOL`));
            return;
        }
        let signature;
        if (tokenInfo.isPump) {
            formatting_1.spinner.text = 'Using pump.fun swap mechanism...';
            signature = await (0, pumpSwap_1.swapSolToPumpToken)(connection, wallet, tokenPublicKey, amount, 0.01);
        }
        else {
            formatting_1.spinner.text = tokenInfo.hasMigrated ?
                'Using regular swap for migrated pump token...' :
                'Using regular swap...';
            signature = await (0, regularSwap_1.swapSolToToken)(connection, wallet, tokenPublicKey, amount * web3_js_1.LAMPORTS_PER_SOL, 0.01);
        }
        // Cleanup BlockhashManager after successful swap
        blockhashManager_1.BlockhashManager.getInstance().cleanup();
        (0, formatting_1.displaySuccess)('Buy successful!');
        console.log(chalk_1.default.hex(config_1.COLORS.SUCCESS)("\nTransaction Details:"));
        console.log("Signature:", chalk_1.default.hex(config_1.COLORS.PRIMARY)(signature));
        console.log("Explorer:", chalk_1.default.hex(config_1.COLORS.PRIMARY)(`https://solscan.io/tx/${signature}`));
    }
    catch (error) {
        // Ensure BlockhashManager is cleaned up on any error
        blockhashManager_1.BlockhashManager.getInstance().cleanup();
        (0, formatting_1.displayError)('Buy failed!', error);
    }
}
