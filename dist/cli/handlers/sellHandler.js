"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleSell = handleSell;
// src/cli/handlers/sellHandler.ts
const web3_js_1 = require("@solana/web3.js");
const index_1 = require("../../index");
const regularSwap_1 = require("../../utils/swaps/regularSwap");
const validation_1 = require("../utils/validation");
const formatting_1 = require("../utils/formatting");
const pumpSwap_1 = require("../../utils/swaps/pumpSwap");
const persistentPoolCache_1 = require("../../utils/pools/persistentPoolCache");
const tokenTypeCache_1 = require("../../utils/pools/tokenTypeCache");
const spl_token_1 = require("@solana/spl-token");
const poolDiscovery_1 = require("../../utils/pools/poolDiscovery");
const blockhashManager_1 = require("../../utils/swaps/blockhashManager");
const chalk_1 = __importDefault(require("chalk"));
const config_1 = require("../config");
const portfolioTracker_1 = require("../../utils/positions/portfolioTracker");
const tokenBalanceMonitor_1 = require("../../utils/positions/tokenBalanceMonitor");
async function handleSell() {
    try {
        // Get token address
        const tokenAddress = await (0, formatting_1.promptWithValidation)('Enter token address to sell: ', validation_1.validatePublicKey, 'Invalid token address format!');
        // Get percentage
        const percentage = await (0, formatting_1.promptWithValidation)('Enter percentage to sell (1-100): ', (input) => {
            const num = parseFloat(input);
            return !isNaN(num) && num > 0 && num <= 100;
        }, 'Invalid percentage! Please enter a number between 1 and 100.');
        const tokenPublicKey = new web3_js_1.PublicKey(tokenAddress);
        formatting_1.spinner.start('Checking token type...');
        const { connection, wallet } = await (0, index_1.setupConnection)();
        // Initialize blockhash manager
        blockhashManager_1.BlockhashManager.getInstance().initialize(connection);
        // Initialize portfolio tracker first to ensure it's ready
        try {
            await portfolioTracker_1.PortfolioTracker.getInstance().initializeBalanceMonitoring();
        }
        catch (error) {
            // Log but continue - not critical for selling
            console.log(chalk_1.default.hex(config_1.COLORS.SECONDARY)('Portfolio initialization error, continuing with sell operation'));
        }
        // Check token type cache first
        const tokenCache = tokenTypeCache_1.TokenTypeCache.getInstance();
        const cachedInfo = tokenCache.getTokenType(tokenAddress);
        // Initialize variables for token type
        let isPump = false;
        let hasMigrated = false;
        if (cachedInfo) {
            if (cachedInfo.type === 'regular') {
                isPump = false;
                hasMigrated = false;
            }
            else if (cachedInfo.type === 'migratedPump') {
                isPump = false;
                hasMigrated = true;
            }
        }
        else {
            // No cache hit, need to check token type
            try {
                const tokenInfo = await (0, pumpSwap_1.isPumpFunToken)(connection, tokenAddress);
                isPump = tokenInfo.isPump;
                hasMigrated = tokenInfo.hasMigrated;
            }
            catch (error) {
                blockhashManager_1.BlockhashManager.getInstance().cleanup(); // Cleanup on token check error
                throw error;
            }
        }
        if (isPump) {
            // Check for Raydium pools first for migrated tokens
            const poolCache = persistentPoolCache_1.PersistentPoolCache.getInstance();
            const [mint1, mint2] = [spl_token_1.NATIVE_MINT.toString(), tokenAddress].sort();
            const poolId = `${mint1}/${mint2}`;
            let hasRaydiumPool = false;
            const cachedPool = poolCache.get(poolId);
            if (cachedPool) {
                hasRaydiumPool = true;
            }
            else {
                try {
                    const poolAccounts = await (0, poolDiscovery_1.discoverPool)(connection, spl_token_1.NATIVE_MINT, tokenPublicKey, true);
                    if (poolAccounts) {
                        hasRaydiumPool = true;
                        poolCache.set(poolId, poolAccounts);
                        tokenCache.setTokenType(tokenAddress, 'migratedPump');
                    }
                }
                catch (err) {
                    hasRaydiumPool = false;
                }
            }
            let signature;
            try {
                if (hasRaydiumPool) {
                    formatting_1.spinner.text = 'Using Raydium swap for migrated pump token...';
                    signature = await (0, regularSwap_1.swapTokenToSol)(connection, wallet, tokenPublicKey, parseFloat(percentage), 0.2);
                }
                else {
                    formatting_1.spinner.text = 'Using pump.fun swap mechanism...';
                    signature = await (0, pumpSwap_1.swapPumpTokenToSol)(connection, wallet, tokenPublicKey, parseFloat(percentage), 0.2);
                }
                // Ensure portfolio is updated after successful swap
                await updatePortfolioAfterSell(connection, wallet.publicKey, tokenAddress);
                // Cleanup BlockhashManager after successful swap
                blockhashManager_1.BlockhashManager.getInstance().cleanup();
                (0, formatting_1.displaySuccess)('Swap successful!');
                console.log(chalk_1.default.hex(config_1.COLORS.SUCCESS)("\nTransaction Details:"));
                console.log("Signature:", chalk_1.default.hex(config_1.COLORS.PRIMARY)(signature));
                console.log("Explorer:", chalk_1.default.hex(config_1.COLORS.PRIMARY)(`https://solscan.io/tx/${signature}`));
            }
            catch (error) {
                blockhashManager_1.BlockhashManager.getInstance().cleanup(); // Cleanup on swap error
                throw error;
            }
        }
        else {
            // Regular token or migrated pump token
            try {
                formatting_1.spinner.text = 'Executing regular swap...';
                const signature = await (0, regularSwap_1.swapTokenToSol)(connection, wallet, tokenPublicKey, parseFloat(percentage), 0.2);
                // Ensure portfolio is updated after successful swap
                await updatePortfolioAfterSell(connection, wallet.publicKey, tokenAddress);
                // Cleanup BlockhashManager after successful swap
                blockhashManager_1.BlockhashManager.getInstance().cleanup();
                (0, formatting_1.displaySuccess)('Swap successful!');
                console.log(chalk_1.default.hex(config_1.COLORS.SUCCESS)("\nTransaction Details:"));
                console.log("Signature:", chalk_1.default.hex(config_1.COLORS.PRIMARY)(signature));
                console.log("Explorer:", chalk_1.default.hex(config_1.COLORS.PRIMARY)(`https://solscan.io/tx/${signature}`));
            }
            catch (error) {
                blockhashManager_1.BlockhashManager.getInstance().cleanup(); // Cleanup on swap error
                throw error;
            }
        }
    }
    catch (error) {
        // Ensure BlockhashManager is cleaned up on any error
        blockhashManager_1.BlockhashManager.getInstance().cleanup();
        (0, formatting_1.displayError)('Sell failed!', error);
    }
}
/**
 * Helper function to update portfolio after a successful sell transaction
 */
async function updatePortfolioAfterSell(connection, walletPublicKey, tokenAddress) {
    try {
        formatting_1.spinner.text = 'Updating portfolio data...';
        // First use the TokenBalanceMonitor for backwards compatibility
        const balanceMonitor = tokenBalanceMonitor_1.TokenBalanceMonitor.getInstance();
        await balanceMonitor.handleConfirmedSellTransaction(connection, walletPublicKey, tokenAddress);
        // Also explicitly refresh the position in PortfolioTracker
        const portfolioTracker = portfolioTracker_1.PortfolioTracker.getInstance();
        await portfolioTracker.refreshPosition(tokenAddress);
        formatting_1.spinner.text = 'Portfolio updated successfully';
    }
    catch (error) {
        console.log(chalk_1.default.hex(config_1.COLORS.ERROR)('Error updating portfolio after sell:'));
        console.error(error);
        // Don't throw - this is a non-critical operation
    }
}
