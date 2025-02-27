"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.swapSolToPumpToken = exports.swapTokenToSol = exports.swapSolToToken = exports.shutdown = exports.handleSellOperation = exports.handleBuyOperation = exports.initializeSwapEnvironment = exports.displayPositions = exports.setupConnection = exports.initializeServices = void 0;
// src/index.ts - Main application entry point
const web3_js_1 = require("@solana/web3.js");
const pumpSwap_1 = require("./utils/swaps/pumpSwap");
Object.defineProperty(exports, "swapSolToPumpToken", { enumerable: true, get: function () { return pumpSwap_1.swapSolToPumpToken; } });
const regularSwap_1 = require("./utils/swaps/regularSwap");
Object.defineProperty(exports, "swapSolToToken", { enumerable: true, get: function () { return regularSwap_1.swapSolToToken; } });
Object.defineProperty(exports, "swapTokenToSol", { enumerable: true, get: function () { return regularSwap_1.swapTokenToSol; } });
const portfolioTracker_1 = require("./utils/positions/portfolioTracker");
const credentialsManager_1 = require("./cli/utils/credentialsManager");
const logger_1 = require("./cli/utils/logger");
const connectionPool_1 = require("./utils/connection/connectionPool");
const blockhashManager_1 = require("./utils/swaps/blockhashManager");
const chalk_1 = __importDefault(require("chalk"));
const config_1 = require("./cli/config");
// Configure global settings
const MIN_SOL_REQUIRED = 0.001;
const BUFFER_SOL = 0.01;
const MAX_RETRIES = 3;
const RETRY_DELAY = 1000;
// Initialize logger
const logger = logger_1.Logger.getInstance();
logger.initialize({
    logLevel: logger_1.LogLevel.INFO,
    logToFile: true
});
// Initialize connection pool and other global services
const initializeServices = async () => {
    // Suppress warnings
    process.removeAllListeners('warning');
    try {
        logger.info('App', 'Initializing services...');
        const credManager = credentialsManager_1.CredentialsManager.getInstance();
        if (!credManager.hasBasicCredentials()) {
            logger.error('App', 'Credentials not configured');
            throw new Error("Credentials not configured. Please set up RPC URL and private key in settings first.");
        }
        // Initialize connection pool
        const connPool = connectionPool_1.ConnectionPool.getInstance();
        connPool.initialize();
        // Get a connection and initialize BlockhashManager
        const connection = connPool.getConnection();
        blockhashManager_1.BlockhashManager.getInstance().initialize(connection);
        // Initialize portfolio tracker
        await portfolioTracker_1.PortfolioTracker.getInstance().initializeBalanceMonitoring();
        logger.success('App', 'Services initialized successfully');
        return;
    }
    catch (error) {
        logger.error('App', 'Failed to initialize services', error);
        if (error instanceof Error) {
            throw error;
        }
        throw new Error("An unknown error occurred during initialization");
    }
};
exports.initializeServices = initializeServices;
// Main setup function to get connection and wallet
const setupConnection = async () => {
    try {
        await (0, exports.initializeServices)();
        const credManager = credentialsManager_1.CredentialsManager.getInstance();
        const connection = connectionPool_1.ConnectionPool.getInstance().getConnection();
        const wallet = credManager.getKeyPair();
        return { connection, wallet };
    }
    catch (error) {
        logger.error('App', 'Failed to set up connection', error);
        if (error instanceof Error) {
            throw new Error(`Failed to setup connection: ${error.message}`);
        }
        throw new Error("Failed to setup connection: Unknown error");
    }
};
exports.setupConnection = setupConnection;
// Display portfolio positions
const displayPositions = async (connection) => {
    if (!connection) {
        const setup = await (0, exports.setupConnection)();
        connection = setup.connection;
    }
    try {
        const { wallet } = await (0, exports.setupConnection)();
        const tracker = portfolioTracker_1.PortfolioTracker.getInstance();
        await tracker.displayPortfolio(connection, wallet.publicKey);
    }
    catch (error) {
        logger.error('Portfolio', 'Failed to display positions', error);
        if (error instanceof Error) {
            throw error;
        }
        throw new Error("Failed to display portfolio positions");
    }
};
exports.displayPositions = displayPositions;
// Initialize swap environment
const initializeSwapEnvironment = async (tokenAddress) => {
    const tokenPublicKey = new web3_js_1.PublicKey(tokenAddress);
    const { connection, wallet } = await (0, exports.setupConnection)();
    try {
        const [walletBalance, tokenInfo] = await Promise.all([
            connection.getBalance(wallet.publicKey),
            tokenAddress.endsWith('pump') ?
                (0, pumpSwap_1.isPumpFunToken)(connection, tokenPublicKey) :
                Promise.resolve({ isPump: false, hasMigrated: false })
        ]);
        return { connection, wallet, tokenInfo, tokenPublicKey, walletBalance };
    }
    catch (error) {
        logger.error('Swap', `Failed to initialize swap environment for ${tokenAddress}`, error);
        if (error instanceof Error) {
            throw error;
        }
        throw new Error(`Failed to initialize swap environment for ${tokenAddress}`);
    }
};
exports.initializeSwapEnvironment = initializeSwapEnvironment;
// Handler for buy operations
const handleBuyOperation = async (connection, wallet, tokenPublicKey, tokenInfo, amountInSol = MIN_SOL_REQUIRED) => {
    let retryCount = MAX_RETRIES;
    let lastError = null;
    while (retryCount > 0) {
        try {
            const signature = tokenInfo.isPump && !tokenInfo.hasMigrated ?
                await (0, pumpSwap_1.swapSolToPumpToken)(connection, wallet, tokenPublicKey, amountInSol, 0.01) :
                await (0, regularSwap_1.swapSolToToken)(connection, wallet, tokenPublicKey, amountInSol * web3_js_1.LAMPORTS_PER_SOL, 0.01);
            logger.success('Buy', `Transaction successful: https://solscan.io/tx/${signature}`);
            return signature;
        }
        catch (error) {
            if (error instanceof Error) {
                lastError = error;
                logger.warn('Buy', `Attempt failed (${MAX_RETRIES - retryCount + 1}/${MAX_RETRIES})`, error.message);
                const isRetryableError = [
                    "exceeded",
                    "blockhash not found",
                    "Transaction simulation failed",
                    "Socket hang up"
                ].some(msg => error.message.includes(msg));
                if (isRetryableError && retryCount > 1) {
                    retryCount--;
                    await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
                    continue;
                }
                throw formatError(error);
            }
            else {
                // For non-Error objects
                lastError = new Error("Unknown error occurred during buy operation");
                logger.warn('Buy', `Attempt failed (${MAX_RETRIES - retryCount + 1}/${MAX_RETRIES}) with unknown error`);
                if (retryCount > 1) {
                    retryCount--;
                    await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
                    continue;
                }
                throw lastError;
            }
        }
    }
    throw lastError || new Error("Operation failed after maximum retries");
};
exports.handleBuyOperation = handleBuyOperation;
// Handler for sell operations
const handleSellOperation = async (connection, wallet, tokenPublicKey, percentageToSell) => {
    try {
        const signature = await (0, regularSwap_1.swapTokenToSol)(connection, wallet, tokenPublicKey, percentageToSell, 0.01);
        logger.success('Sell', `Transaction successful: https://solscan.io/tx/${signature}`);
        return signature;
    }
    catch (error) {
        logger.error('Sell', 'Failed to sell token', error);
        if (error instanceof Error) {
            throw formatError(error);
        }
        throw new Error("Failed to sell token: Unknown error");
    }
};
exports.handleSellOperation = handleSellOperation;
// Format errors for better user experience
function formatError(error) {
    const errorMessages = {
        "No liquidity pool found": "No liquidity pool exists for this token pair",
        "insufficient funds": "Insufficient funds for swap",
        "exceeds desired slippage limit": "Price impact too high. Try increasing slippage tolerance or reducing amount",
        "0x1": "Transaction failed - check token contract and pool status",
        "TooLittleSolReceived": "Price impact too high. Try reducing amount or increasing slippage tolerance",
        "BondingCurveComplete": "This token has already migrated to Raydium"
    };
    const message = error.message || String(error);
    for (const [key, value] of Object.entries(errorMessages)) {
        if (message.includes(key))
            return new Error(value);
    }
    return error;
}
// Graceful shutdown handler
const shutdown = async () => {
    try {
        logger.info('App', 'Shutting down...');
        // Cleanup portfolio tracker
        await portfolioTracker_1.PortfolioTracker.getInstance().cleanup();
        // Cleanup blockhash manager
        blockhashManager_1.BlockhashManager.getInstance().cleanup();
        // Cleanup connection pool
        connectionPool_1.ConnectionPool.getInstance().cleanup();
        logger.success('App', 'Shutdown completed successfully');
    }
    catch (error) {
        logger.error('App', 'Error during shutdown', error);
    }
};
exports.shutdown = shutdown;
// Handle process termination signals
process.on('SIGINT', async () => {
    console.log(chalk_1.default.hex(config_1.COLORS.PRIMARY)("\nReceived SIGINT, shutting down..."));
    await (0, exports.shutdown)();
    process.exit(0);
});
process.on('SIGTERM', async () => {
    console.log(chalk_1.default.hex(config_1.COLORS.PRIMARY)("\nReceived SIGTERM, shutting down..."));
    await (0, exports.shutdown)();
    process.exit(0);
});
// Command-line interface entry point
if (require.main === module) {
    (async () => {
        try {
            const command = process.argv[2];
            if (!command) {
                console.error(chalk_1.default.hex(config_1.COLORS.ERROR)("Usage:\nnpm start <token-address> (buy)\nnpm start sell <token-address> <percentage> (sell)\nnpm start positions (view)"));
                process.exit(1);
            }
            await (0, exports.initializeServices)();
            if (command === "positions") {
                await (0, exports.displayPositions)();
                await (0, exports.shutdown)();
                return;
            }
            if (command === "sell") {
                const tokenAddress = process.argv[3];
                const percentage = parseFloat(process.argv[4]);
                if (!tokenAddress || isNaN(percentage) || percentage <= 0 || percentage > 100) {
                    console.error(chalk_1.default.hex(config_1.COLORS.ERROR)("Usage: npm start sell <token-address> <percentage>"));
                    process.exit(1);
                }
                const { connection, wallet } = await (0, exports.setupConnection)();
                await (0, exports.handleSellOperation)(connection, wallet, new web3_js_1.PublicKey(tokenAddress), percentage);
                await (0, exports.shutdown)();
                return;
            }
            // Default to buy operation
            const { connection, wallet, tokenInfo, tokenPublicKey, walletBalance } = await (0, exports.initializeSwapEnvironment)(command);
            const requiredBalance = (MIN_SOL_REQUIRED + BUFFER_SOL) * web3_js_1.LAMPORTS_PER_SOL;
            if (walletBalance < requiredBalance) {
                throw new Error(`Insufficient SOL balance. Required: ${(requiredBalance / web3_js_1.LAMPORTS_PER_SOL).toFixed(3)} SOL, ` +
                    `Current: ${(walletBalance / web3_js_1.LAMPORTS_PER_SOL).toFixed(3)} SOL`);
            }
            await (0, exports.handleBuyOperation)(connection, wallet, tokenPublicKey, tokenInfo);
            await (0, exports.shutdown)();
        }
        catch (error) {
            if (error instanceof Error) {
                if (error.message.includes("Invalid public key input")) {
                    logger.error('App', "Invalid token address format");
                    console.error(chalk_1.default.hex(config_1.COLORS.ERROR)("Invalid token address format"));
                }
                else {
                    logger.error('App', error.message);
                    console.error(chalk_1.default.hex(config_1.COLORS.ERROR)(error.message));
                }
            }
            else {
                logger.error('App', 'Unknown error occurred');
                console.error(chalk_1.default.hex(config_1.COLORS.ERROR)("An unknown error occurred"));
            }
            await (0, exports.shutdown)();
            process.exit(1);
        }
    })();
}
exports.default = { setupConnection: exports.setupConnection, displayPositions: exports.displayPositions, handleBuyOperation: exports.handleBuyOperation, handleSellOperation: exports.handleSellOperation };
