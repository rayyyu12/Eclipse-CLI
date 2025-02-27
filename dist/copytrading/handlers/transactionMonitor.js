"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TransactionMonitor = void 0;
// src/copytrading/handlers/transactionMonitor.ts
const events_1 = require("events");
const yellowstone_grpc_1 = __importStar(require("@triton-one/yellowstone-grpc"));
const web3_js_1 = require("@solana/web3.js");
const spl_token_1 = require("@solana/spl-token");
const bs58_1 = __importDefault(require("bs58"));
const constants_1 = require("../../utils/swaps/constants");
const types_1 = require("../types/types");
const credentialsManager_1 = require("../../cli/utils/credentialsManager");
const raydiumCopySwap_1 = require("./swaps/raydiumCopySwap");
const pumpCopySwap_1 = require("./swaps/pumpCopySwap");
const portfolioTracker_1 = require("../../utils/positions/portfolioTracker");
const pumpSwap_1 = require("../../utils/swaps/pumpSwap");
const copyTradingSettings_1 = require("../../cli/utils/copyTradingSettings");
const copyTradeLogger_1 = require("../../cli/utils/copyTradeLogger");
const connectionPool_1 = require("../.././utils/connection/connectionPool");
const logger_1 = require("../../cli/utils/logger");
class TransactionMonitor extends events_1.EventEmitter {
    constructor(config) {
        super();
        this.pingInterval = null;
        this.cleanupInterval = null;
        this.PING_INTERVAL_MS = 30000;
        this.MAX_RECONNECT_ATTEMPTS = 5;
        this.reconnectAttempts = 0;
        this.MAX_PROCESSED_TRANSACTIONS = 1000;
        this.processedTransactions = new Set();
        this.config = config;
        this.walletSet = new Set(config.wallets);
        this.logger = copyTradeLogger_1.CopyTradeLogger.getInstance();
        this.systemLogger = logger_1.Logger.getInstance();
        this.connectionPool = connectionPool_1.ConnectionPool.getInstance();
        this.status = {
            isActive: false,
            processedTransactions: 0,
            detectedSwaps: 0,
            successfulCopies: 0,
            failedCopies: 0
        };
        this.client = new yellowstone_grpc_1.default(config.grpcEndpoint, config.xToken, {
            commitment: config.commitment || yellowstone_grpc_1.CommitmentLevel.PROCESSED,
            "grpc.keepalive_time_ms": 120000,
            "grpc.http2.min_time_between_pings_ms": 120000,
            "grpc.keepalive_timeout_ms": 20000,
            "grpc.http2.max_pings_without_data": 0,
            "grpc.keepalive_permit_without_calls": 1,
            "grpc.max_receive_message_length": 64 * 1024 * 1024
        });
        this.setupCleanupInterval();
    }
    async start() {
        if (this.status.isActive) {
            this.systemLogger.warn('TransactionMonitor', 'Monitor is already running');
            return;
        }
        try {
            const portfolioTracker = portfolioTracker_1.PortfolioTracker.getInstance();
            await portfolioTracker.initializeBalanceMonitoring();
            await this.connect();
            this.status.isActive = true;
            this.status.connectedAt = new Date();
            this.emit('started', this.status);
            this.setupReconnection();
            this.systemLogger.success('TransactionMonitor', 'Monitor started successfully');
        }
        catch (error) {
            this.systemLogger.error('TransactionMonitor', 'Error starting monitor', error);
            this.emit('error', {
                type: 'STARTUP_ERROR',
                message: error instanceof Error ? error.message : 'Unknown startup error',
                timestamp: new Date()
            });
            throw error;
        }
    }
    async stop() {
        if (!this.status.isActive)
            return;
        try {
            if (this.pingInterval) {
                clearInterval(this.pingInterval);
                this.pingInterval = null;
            }
            if (this.cleanupInterval) {
                clearInterval(this.cleanupInterval);
                this.cleanupInterval = null;
            }
            if (this.subscription) {
                this.subscription.end();
                this.subscription = null;
            }
            this.status.isActive = false;
            this.emit('stopped', this.status);
            this.systemLogger.info('TransactionMonitor', 'Monitor stopped successfully');
        }
        catch (error) {
            this.systemLogger.error('TransactionMonitor', 'Error stopping monitor', error);
            throw error;
        }
    }
    async connect() {
        try {
            this.systemLogger.info('TransactionMonitor', 'Connecting to gRPC endpoint...');
            this.subscription = await this.client.subscribe();
            const programsToMonitor = [];
            if (this.config.enablePump)
                programsToMonitor.push(constants_1.PUMP_FUN_PROGRAM_ID.toBase58());
            if (this.config.enableRaydium)
                programsToMonitor.push(constants_1.RAYDIUM_AMM_PROGRAM_ID.toBase58());
            if (programsToMonitor.length === 0) {
                throw new Error('At least one program must be enabled for monitoring');
            }
            this.systemLogger.info('TransactionMonitor', `Monitoring wallets: ${Array.from(this.walletSet).join(', ')}`);
            this.systemLogger.info('TransactionMonitor', `Monitoring programs: ${programsToMonitor.join(', ')}`);
            const request = {
                accounts: {},
                slots: {},
                transactions: {
                    swapTransactions: {
                        vote: false,
                        failed: false,
                        signature: undefined,
                        accountInclude: programsToMonitor,
                        accountExclude: [],
                        accountRequired: this.config.wallets.length > 0 ? this.config.wallets : undefined,
                    }
                },
                transactionsStatus: {},
                entry: {},
                blocks: {},
                blocksMeta: {},
                accountsDataSlice: [],
                ping: undefined,
                commitment: this.config.commitment || yellowstone_grpc_1.CommitmentLevel.PROCESSED
            };
            this.subscription.on('data', (data) => {
                if (data.transaction?.transaction) {
                    this.status.processedTransactions++;
                    this.handleTransaction(data.transaction);
                }
            });
            this.subscription.on('error', (error) => {
                this.systemLogger.error('TransactionMonitor', 'Stream error', error);
                this.emit('error', {
                    type: 'SUBSCRIPTION_ERROR',
                    message: error.message,
                    timestamp: new Date()
                });
            });
            await new Promise((resolve, reject) => {
                this.subscription.write(request, (err) => {
                    if (err) {
                        this.systemLogger.error('TransactionMonitor', 'Error writing subscription', err);
                        reject(err);
                    }
                    else {
                        resolve();
                    }
                });
            });
            this.setupPingInterval();
            this.systemLogger.success('TransactionMonitor', 'Connected to gRPC endpoint successfully');
        }
        catch (error) {
            this.systemLogger.error('TransactionMonitor', 'Error in connection process', error);
            throw error;
        }
    }
    setupReconnection() {
        this.subscription.on('end', () => {
            this.systemLogger.warn('TransactionMonitor', 'Subscription ended unexpectedly');
            this.attemptReconnect();
        });
        this.subscription.on('close', () => {
            this.systemLogger.warn('TransactionMonitor', 'Subscription closed unexpectedly');
            this.attemptReconnect();
        });
    }
    async attemptReconnect() {
        if (!this.status.isActive)
            return;
        if (this.reconnectAttempts >= this.MAX_RECONNECT_ATTEMPTS) {
            this.systemLogger.error('TransactionMonitor', 'Max reconnection attempts reached');
            this.emit('error', {
                type: 'MAX_RECONNECT_ERROR',
                message: 'Failed to reconnect after maximum attempts',
                timestamp: new Date()
            });
            await this.stop();
            return;
        }
        this.reconnectAttempts++;
        this.systemLogger.info('TransactionMonitor', `Attempting to reconnect (attempt ${this.reconnectAttempts}/${this.MAX_RECONNECT_ATTEMPTS})...`);
        try {
            await this.connect();
            this.reconnectAttempts = 0;
            this.systemLogger.success('TransactionMonitor', 'Successfully reconnected');
        }
        catch (error) {
            this.systemLogger.error('TransactionMonitor', 'Reconnection attempt failed', error);
            setTimeout(() => this.attemptReconnect(), 5000);
        }
    }
    setupPingInterval() {
        if (this.pingInterval)
            clearInterval(this.pingInterval);
        this.pingInterval = setInterval(() => {
            const status = this.getStatus();
            if (status.lastTransactionAt) {
                const lastTxAge = Date.now() - status.lastTransactionAt.getTime();
                if (lastTxAge > this.PING_INTERVAL_MS * 2) {
                    this.systemLogger.warn('TransactionMonitor', `No transactions received for ${Math.round(lastTxAge / 1000)}s`);
                    this.attemptReconnect();
                }
            }
        }, this.PING_INTERVAL_MS);
    }
    setupCleanupInterval() {
        if (this.cleanupInterval)
            clearInterval(this.cleanupInterval);
        this.cleanupInterval = setInterval(() => {
            if (this.processedTransactions.size > this.MAX_PROCESSED_TRANSACTIONS) {
                const transactions = Array.from(this.processedTransactions);
                const toKeep = transactions.slice(-this.MAX_PROCESSED_TRANSACTIONS);
                this.processedTransactions = new Set(toKeep);
                this.systemLogger.debug('TransactionMonitor', `Cleaned up transaction cache, reduced from ${transactions.length} to ${toKeep.length} items`);
            }
        }, 60 * 60 * 1000); // Run once per hour
    }
    async handleTransaction(tx) {
        try {
            if (!tx.transaction?.signature)
                return;
            const signature = tx.transaction.signature instanceof Uint8Array
                ? bs58_1.default.encode(tx.transaction.signature)
                : tx.transaction.signature?.type === 'Buffer'
                    ? bs58_1.default.encode(Buffer.from(tx.transaction.signature.data))
                    : tx.transaction.signature;
            if (this.processedTransactions.has(signature))
                return;
            // Add to processed transactions first to avoid duplicate processing
            this.processedTransactions.add(signature);
            const walletAddress = await this.extractWalletAddress(tx);
            if (!walletAddress || !this.walletSet.has(walletAddress))
                return;
            const botWallet = credentialsManager_1.CredentialsManager.getInstance().getKeyPair().publicKey.toString();
            if (walletAddress === botWallet)
                return;
            const logs = tx.transaction.meta?.logMessages || [];
            const isPumpTransaction = logs.some((log) => (typeof log === 'string' ? log : log.message).includes('Program ' + constants_1.PUMP_FUN_PROGRAM_ID.toString()));
            const isRaydiumTransaction = logs.some((log) => (typeof log === 'string' ? log : log.message).includes('ray_log:'));
            if (!isPumpTransaction && !isRaydiumTransaction)
                return;
            let swapData = null;
            if (isPumpTransaction) {
                // Handle Pump.fun transaction
                swapData = this.extractPumpSwapDetails(tx, walletAddress);
                if (swapData?.success && swapData?.amountIn !== undefined && swapData?.amountOut !== undefined) {
                    await this.executeCopyTrade(swapData, signature);
                }
            }
            else {
                // Handle Raydium transaction
                const rayLog = logs.find((log) => (typeof log === 'string' ? log : log.message).includes('ray_log:'));
                if (!rayLog)
                    return;
                const poolAccountsData = await this.extractRaydiumPoolAccounts(tx);
                if (!poolAccountsData)
                    return;
                const [preBalances, postBalances] = [
                    tx.transaction.meta?.preTokenBalances || [],
                    tx.transaction.meta?.postTokenBalances || []
                ];
                const tokenChanges = this.calculateTokenChanges(preBalances, postBalances);
                const swapDetails = await this.extractSwapDetails(tx, walletAddress, poolAccountsData, preBalances, postBalances);
                if (!tokenChanges || !swapDetails)
                    return;
                const swapDirection = this.detectSwapDirection(preBalances, postBalances, swapDetails.poolBalances);
                swapData = {
                    swapType: types_1.SwapType.RAYDIUM,
                    tokenAddress: tokenChanges.tokenMint,
                    ammId: poolAccountsData.ammId,
                    ammAuthority: poolAccountsData.ammAuthority,
                    ammOpenOrders: poolAccountsData.ammOpenOrders,
                    ammTargetOrders: poolAccountsData.ammTargetOrders,
                    poolCoinTokenAccount: poolAccountsData.poolCoinTokenAccount,
                    poolPcTokenAccount: poolAccountsData.poolPcTokenAccount,
                    poolLpTokenAccount: poolAccountsData.poolLpTokenAccount,
                    poolTempLpTokenAccount: poolAccountsData.poolTempLpTokenAccount,
                    serumProgramId: poolAccountsData.serumProgramId,
                    serumMarket: poolAccountsData.serumMarket,
                    serumBids: poolAccountsData.serumBids,
                    serumAsks: poolAccountsData.serumAsks,
                    serumEventQueue: poolAccountsData.serumEventQueue,
                    serumBaseVault: poolAccountsData.serumBaseVault,
                    serumQuoteVault: poolAccountsData.serumQuoteVault,
                    serumOpenOrders: poolAccountsData.serumOpenOrders,
                    tokenInMint: tokenChanges.tokenIn,
                    tokenOutMint: tokenChanges.tokenOut,
                    success: (tx.transaction.meta?.err == null),
                    walletAddress,
                    isBuy: swapDirection === 'buy',
                    poolBalances: swapDetails.poolBalances,
                    amountIn: tokenChanges.amountIn,
                    amountOut: tokenChanges.amountOut,
                    signature,
                    programId: constants_1.RAYDIUM_AMM_PROGRAM_ID.toBase58(),
                    rayLogData: (typeof rayLog === 'string' ? rayLog : rayLog.message).split('ray_log: ')[1],
                    timestamp: new Date(),
                    userAccounts: Object.fromEntries(swapDetails.userAccounts),
                    slot: swapDetails.slot,
                    decimalsIn: tokenChanges.decimalsIn,
                    decimalsOut: tokenChanges.decimalsOut
                };
                if (swapData.success) {
                    await this.executeCopyTrade(swapData, signature);
                }
            }
            if (!swapData)
                return;
            this.status.lastTransactionAt = new Date();
            this.status.detectedSwaps++;
            if (swapData.success) {
                this.status.successfulCopies++;
            }
            else {
                this.status.failedCopies++;
            }
            this.emit('swap', swapData);
        }
        catch (error) {
            this.systemLogger.error('TransactionMonitor', 'Error processing transaction', error);
            this.emit('error', {
                type: 'PARSE_ERROR',
                message: error instanceof Error ? error.message : 'Unknown error processing transaction',
                timestamp: new Date()
            });
        }
    }
    // -------------------------------------------------------------------------
    // COPY TRADE EXECUTION
    // -------------------------------------------------------------------------
    async executeCopyTrade(swapData, originalSignature) {
        const startTime = Date.now();
        try {
            const credManager = credentialsManager_1.CredentialsManager.getInstance();
            // Use connection pool instead of direct connection
            const connection = this.connectionPool.getConnection();
            const wallet = credManager.getKeyPair();
            const settings = copyTradingSettings_1.CopyTradeSettingsManager.getInstance().getSettings();
            if (swapData.swapType === types_1.SwapType.PUMP && !settings.enabled.pump) {
                throw new Error('Pump.fun trading is disabled in settings');
            }
            if (swapData.swapType === types_1.SwapType.RAYDIUM && !settings.enabled.raydium) {
                throw new Error('Raydium trading is disabled in settings');
            }
            this.logger.addLog({
                type: 'info',
                protocol: swapData.swapType,
                message: `Executing ${swapData.isBuy ? 'BUY' : 'SELL'} on ${swapData.swapType}`,
                details: {
                    originalTx: originalSignature,
                    tokenAddress: swapData.tokenAddress.toString()
                }
            });
            this.systemLogger.info('TransactionMonitor', `Executing ${swapData.isBuy ? 'BUY' : 'SELL'} for ${swapData.tokenAddress.toString()} on ${swapData.swapType}`, { originalTx: originalSignature });
            let copySignature;
            if (swapData.swapType === types_1.SwapType.PUMP) {
                const pumpData = swapData;
                if (!pumpData.amountOut || !pumpData.amountIn) {
                    throw new Error('Missing swap amounts in original transaction');
                }
                if (pumpData.isBuy) {
                    let amountInLamports = settings.buyMode === copyTradingSettings_1.BuyMode.FIXED ?
                        settings.fixedBuyAmount * web3_js_1.LAMPORTS_PER_SOL :
                        pumpData.amountIn * web3_js_1.LAMPORTS_PER_SOL;
                    const amountInSol = amountInLamports / web3_js_1.LAMPORTS_PER_SOL;
                    if (amountInSol < settings.minBuyAmount) {
                        throw new Error(`Buy amount ${amountInSol} SOL below minimum ${settings.minBuyAmount} SOL`);
                    }
                    if (amountInSol > settings.maxBuyAmount) {
                        throw new Error(`Buy amount ${amountInSol} SOL above maximum ${settings.maxBuyAmount} SOL`);
                    }
                    this.logger.addLog({
                        type: 'info',
                        protocol: types_1.SwapType.PUMP,
                        message: `Buying with ${amountInSol} SOL`,
                        details: { amount: amountInSol, tokenAddress: pumpData.tokenAddress.toString() }
                    });
                    this.systemLogger.info('TransactionMonitor', `Buying with ${amountInSol} SOL on Pump.fun`, { tokenAddress: pumpData.tokenAddress.toString() });
                    copySignature = await (0, pumpCopySwap_1.copyPumpBuySwap)(connection, wallet, pumpData, amountInLamports);
                }
                else {
                    const portfolioTracker = portfolioTracker_1.PortfolioTracker.getInstance();
                    const position = await portfolioTracker.getPosition(pumpData.tokenAddress.toString());
                    if (!position) {
                        const userTokenAccount = await (0, spl_token_1.getAssociatedTokenAddress)(pumpData.tokenAddress, wallet.publicKey);
                        const accountInfo = await connection.getTokenAccountBalance(userTokenAccount);
                        if (!accountInfo?.value?.uiAmount || accountInfo.value.uiAmount <= 0) {
                            throw new Error('No tokens available to sell');
                        }
                        const tokenBalance = accountInfo.value.uiAmount;
                        const amountToSell = Math.floor(tokenBalance * Math.pow(10, 6));
                        this.logger.addLog({
                            type: 'info',
                            protocol: types_1.SwapType.PUMP,
                            message: `Selling ${tokenBalance} tokens`,
                            details: { amount: tokenBalance, tokenAddress: pumpData.tokenAddress.toString() }
                        });
                        copySignature = await (0, pumpCopySwap_1.copyPumpSellSwap)(connection, wallet, pumpData, amountToSell, settings.slippageTolerance.pump / 100);
                    }
                    else {
                        const tokenBalance = position.remainingValue / position.currentPriceSol;
                        const amountToSell = Math.floor(tokenBalance * Math.pow(10, 6));
                        this.logger.addLog({
                            type: 'info',
                            protocol: types_1.SwapType.PUMP,
                            message: `Selling ${tokenBalance} tokens from position`,
                            details: { amount: tokenBalance, tokenAddress: pumpData.tokenAddress.toString() }
                        });
                        this.systemLogger.info('TransactionMonitor', `Selling ${tokenBalance} tokens from position on Pump.fun`, { tokenAddress: pumpData.tokenAddress.toString() });
                        copySignature = await (0, pumpCopySwap_1.copyPumpSellSwap)(connection, wallet, pumpData, amountToSell, settings.slippageTolerance.pump / 100);
                    }
                }
            }
            else {
                const raydiumData = swapData;
                if (!raydiumData.poolBalances?.coin || !raydiumData.poolBalances?.pc) {
                    throw new Error("Missing pool balance information");
                }
                const userToken = Object.values(raydiumData.userAccounts || {}).find((acct) => acct.mint === raydiumData.tokenAddress.toString());
                const tokenDecimals = userToken?.decimals || 6;
                if (raydiumData.isBuy) {
                    let amountInLamports = settings.buyMode === copyTradingSettings_1.BuyMode.FIXED ?
                        settings.fixedBuyAmount * web3_js_1.LAMPORTS_PER_SOL :
                        raydiumData.amountIn * web3_js_1.LAMPORTS_PER_SOL;
                    const amountInSol = amountInLamports / web3_js_1.LAMPORTS_PER_SOL;
                    if (amountInSol < settings.minBuyAmount) {
                        throw new Error(`Buy amount ${amountInSol} SOL below minimum ${settings.minBuyAmount} SOL`);
                    }
                    if (amountInSol > settings.maxBuyAmount) {
                        throw new Error(`Buy amount ${amountInSol} SOL above maximum ${settings.maxBuyAmount} SOL`);
                    }
                    this.logger.addLog({
                        type: 'info',
                        protocol: types_1.SwapType.RAYDIUM,
                        message: `Buying with ${amountInSol} SOL`,
                        details: { amount: amountInSol, tokenAddress: raydiumData.tokenAddress.toString() }
                    });
                    this.systemLogger.info('TransactionMonitor', `Buying with ${amountInSol} SOL on Raydium`, { tokenAddress: raydiumData.tokenAddress.toString() });
                    copySignature = await (0, raydiumCopySwap_1.copyRaydiumSwap)(connection, wallet, raydiumData, amountInLamports);
                }
                else {
                    const portfolioTracker = portfolioTracker_1.PortfolioTracker.getInstance();
                    const position = await portfolioTracker.getPosition(raydiumData.tokenAddress.toString());
                    if (!position) {
                        throw new Error('No token position found for selling');
                    }
                    const tokenAmount = position.remainingValue / position.currentPriceSol;
                    const amountToSell = Math.floor(tokenAmount * Math.pow(10, tokenDecimals));
                    this.logger.addLog({
                        type: 'info',
                        protocol: types_1.SwapType.RAYDIUM,
                        message: `Selling ${tokenAmount} tokens`,
                        details: { amount: tokenAmount, tokenAddress: raydiumData.tokenAddress.toString() }
                    });
                    this.systemLogger.info('TransactionMonitor', `Selling ${tokenAmount} tokens on Raydium`, { tokenAddress: raydiumData.tokenAddress.toString() });
                    copySignature = await (0, raydiumCopySwap_1.copyRaydiumSwap)(connection, wallet, {
                        ...raydiumData,
                        tokenInMint: raydiumData.tokenAddress.toString(),
                        tokenOutMint: spl_token_1.NATIVE_MINT.toString()
                    }, amountToSell);
                }
            }
            const executionTime = Date.now() - startTime;
            this.logger.addLog({
                type: 'success',
                protocol: swapData.swapType,
                message: 'Copy trade successful',
                details: {
                    signature: copySignature,
                    originalTx: originalSignature,
                    type: swapData.isBuy ? 'BUY' : 'SELL',
                    tokenAddress: swapData.tokenAddress.toString(),
                    explorer: `https://solscan.io/tx/${copySignature}`,
                    executionTimeMs: executionTime
                }
            });
            this.systemLogger.success('TransactionMonitor', `Copy trade successful in ${executionTime}ms`, {
                signature: copySignature,
                originalTx: originalSignature,
                type: swapData.isBuy ? 'BUY' : 'SELL',
                tokenAddress: swapData.tokenAddress.toString()
            });
            this.emit('copyTradeSuccess', {
                originalSignature,
                copySignature,
                protocol: swapData.swapType,
                type: swapData.isBuy ? 'BUY' : 'SELL',
                tokenAddress: swapData.tokenAddress.toString(),
                executionTimeMs: executionTime
            });
        }
        catch (error) {
            const executionTime = Date.now() - startTime;
            this.logger.addLog({
                type: 'error',
                protocol: swapData.swapType,
                message: error instanceof Error ? error.message : 'Unknown error',
                details: {
                    originalTx: originalSignature,
                    type: swapData.isBuy ? 'BUY' : 'SELL',
                    tokenAddress: swapData.tokenAddress.toString(),
                    executionTimeMs: executionTime
                }
            });
            this.systemLogger.error('TransactionMonitor', `Copy trade failed in ${executionTime}ms`, {
                originalTx: originalSignature,
                type: swapData.isBuy ? 'BUY' : 'SELL',
                tokenAddress: swapData.tokenAddress.toString(),
                error: error instanceof Error ? error.message : 'Unknown error'
            });
            this.emit('copyTradeError', {
                originalSignature,
                error: error instanceof Error ? error.message : 'Unknown error',
                protocol: swapData.swapType,
                type: swapData.isBuy ? 'BUY' : 'SELL',
                tokenAddress: swapData.tokenAddress.toString(),
                executionTimeMs: executionTime
            });
            throw error;
        }
    }
    // -------------------------------------------------------------------------
    // PUMP DETECTION & DETAILS
    // -------------------------------------------------------------------------
    // Continuation of extractPumpSwapDetails in transactionmonitor.ts
    extractPumpSwapDetails(tx, walletAddress) {
        try {
            const accounts = tx.transaction?.transaction?.message?.accountKeys;
            const instructions = tx.transaction?.transaction?.message?.instructions;
            const innerInstructions = tx.transaction?.meta?.innerInstructions || [];
            // Function to check if an instruction is a pump instruction
            const isPumpInstruction = (ix, accountKeys) => {
                const programId = accountKeys[ix.programIdIndex];
                return ((programId instanceof Uint8Array || programId?.type === 'Buffer') &&
                    new web3_js_1.PublicKey(programId).equals(constants_1.PUMP_FUN_PROGRAM_ID));
            };
            // Find pump instruction either in main instructions or inner instructions
            let pumpInstruction = null;
            let instructionAccounts = accounts;
            // First check main instructions
            pumpInstruction = instructions?.find((ix) => isPumpInstruction(ix, accounts));
            // If not found in main instructions, check inner instructions
            if (!pumpInstruction) {
                for (const inner of innerInstructions) {
                    const innerIx = inner.instructions.find((ix) => isPumpInstruction(ix, accounts));
                    if (innerIx) {
                        pumpInstruction = innerIx;
                        break;
                    }
                }
            }
            if (!pumpInstruction)
                return null;
            const data = Buffer.from(pumpInstruction.data);
            const buyDiscriminator = (0, pumpSwap_1.deriveInstructionDiscriminator)('global', 'buy');
            const sellDiscriminator = (0, pumpSwap_1.deriveInstructionDiscriminator)('global', 'sell');
            const isBuy = data.slice(0, 8).equals(buyDiscriminator);
            const isSell = data.slice(0, 8).equals(sellDiscriminator);
            if (!isBuy && !isSell)
                return null;
            const getAccountFromIndex = (index) => {
                const account = accounts[index];
                if (account instanceof Uint8Array) {
                    return new web3_js_1.PublicKey(account);
                }
                else if (account?.type === 'Buffer') {
                    return new web3_js_1.PublicKey(Buffer.from(account.data));
                }
                throw new Error(`Invalid account at index ${index}`);
            };
            const keys = pumpInstruction.accounts;
            const mint = getAccountFromIndex(keys[2]);
            const bondingCurve = getAccountFromIndex(keys[3]);
            const associatedBondingCurve = getAccountFromIndex(keys[4]);
            const userTokenAccount = getAccountFromIndex(keys[5]);
            // Find the relevant token balances by checking all pre/post balances
            const preBalances = tx.transaction.meta?.preTokenBalances || [];
            const postBalances = tx.transaction.meta?.postTokenBalances || [];
            // For wrapped transactions, we need to look for the token account that matches our mint
            const relevantPreBalance = preBalances.find((b) => b.mint === mint.toString());
            const relevantPostBalance = postBalances.find((b) => b.mint === mint.toString());
            let tokenAmount;
            const preAmount = relevantPreBalance?.uiTokenAmount?.uiAmount ?? 0;
            const postAmount = relevantPostBalance?.uiTokenAmount?.uiAmount;
            if (postAmount !== undefined) {
                tokenAmount = Math.abs(Number(postAmount) - Number(preAmount));
            }
            // For SOL amount, we need to look at the wallet's SOL balance change
            const accountPreBalances = tx.transaction.meta?.preBalances || [];
            const accountPostBalances = tx.transaction.meta?.postBalances || [];
            // Find the index of our target wallet
            const walletIndex = accounts.findIndex((acc) => {
                const pk = acc instanceof Uint8Array ? new web3_js_1.PublicKey(acc) : new web3_js_1.PublicKey(acc.toString());
                return pk.toString() === walletAddress;
            });
            let solChange;
            if (walletIndex !== -1 &&
                accountPreBalances[walletIndex] !== undefined &&
                accountPostBalances[walletIndex] !== undefined) {
                solChange = Math.abs(accountPostBalances[walletIndex] - accountPreBalances[walletIndex]) / web3_js_1.LAMPORTS_PER_SOL;
            }
            if (solChange === undefined || tokenAmount === undefined)
                return null;
            const swapData = {
                swapType: types_1.SwapType.PUMP,
                tokenAddress: mint,
                bondingCurve,
                associatedBondingCurve,
                virtualTokenReserves: '',
                virtualSolReserves: '',
                walletAddress,
                isBuy,
                success: tx.transaction.meta?.err == null,
                userTokenAccount,
                amountIn: isBuy ? solChange : tokenAmount,
                amountOut: isBuy ? tokenAmount : solChange,
                decimalsIn: isBuy ? 9 : 6,
                decimalsOut: isBuy ? 6 : 9,
                signature: tx.transaction.signature instanceof Uint8Array
                    ? bs58_1.default.encode(tx.transaction.signature)
                    : tx.transaction.signature,
                timestamp: new Date()
            };
            return swapData;
        }
        catch (error) {
            this.systemLogger.error('TransactionMonitor', 'Error extracting pump.fun swap details', error);
            return null;
        }
    }
    // -------------------------------------------------------------------------
    // RAYDIUM DETECTION & DETAILS
    // -------------------------------------------------------------------------
    extractRaydiumPoolAccounts(tx) {
        try {
            const accounts = tx.transaction?.transaction?.message?.accountKeys;
            if (!accounts || !Array.isArray(accounts))
                return null;
            const instructions = tx.transaction?.transaction?.message?.instructions;
            const raydiumInstruction = instructions?.find((ix) => {
                const programId = accounts[ix.programIdIndex];
                return ((programId instanceof Uint8Array || programId?.type === 'Buffer') &&
                    new web3_js_1.PublicKey(programId).equals(constants_1.RAYDIUM_AMM_PROGRAM_ID));
            });
            if (!raydiumInstruction)
                return null;
            const getAccountFromIndex = (index) => {
                const account = accounts[index];
                if (account instanceof Uint8Array) {
                    return new web3_js_1.PublicKey(account);
                }
                else if (account?.type === 'Buffer') {
                    return new web3_js_1.PublicKey(Buffer.from(account.data));
                }
                throw new Error(`Invalid account at index ${index}`);
            };
            const keys = raydiumInstruction.accounts;
            const poolCoinTokenAccount = getAccountFromIndex(keys[5]);
            const tokenAddress = poolCoinTokenAccount;
            const poolAccounts = {
                swapType: types_1.SwapType.RAYDIUM,
                tokenAddress,
                ammId: getAccountFromIndex(keys[1]),
                ammAuthority: getAccountFromIndex(keys[2]),
                ammOpenOrders: getAccountFromIndex(keys[3]),
                ammTargetOrders: getAccountFromIndex(keys[4]),
                poolCoinTokenAccount,
                poolPcTokenAccount: getAccountFromIndex(keys[6]),
                poolLpTokenAccount: getAccountFromIndex(keys[15]),
                poolTempLpTokenAccount: getAccountFromIndex(keys[16]),
                serumProgramId: getAccountFromIndex(keys[7]),
                serumMarket: getAccountFromIndex(keys[8]),
                serumBids: getAccountFromIndex(keys[9]),
                serumAsks: getAccountFromIndex(keys[10]),
                serumEventQueue: getAccountFromIndex(keys[11]),
                serumBaseVault: getAccountFromIndex(keys[12]),
                serumQuoteVault: getAccountFromIndex(keys[13]),
                serumOpenOrders: getAccountFromIndex(keys[14])
            };
            return poolAccounts;
        }
        catch (error) {
            this.systemLogger.error('TransactionMonitor', 'Error extracting pool accounts', error);
            return null;
        }
    }
    async extractSwapDetails(tx, walletAddress, poolAccounts, preBalances, postBalances) {
        try {
            const userAccounts = preBalances.filter(balance => balance.owner === walletAddress);
            const accountBalances = new Map();
            for (const preBalance of userAccounts) {
                const postBalance = postBalances.find(p => p.accountIndex === preBalance.accountIndex);
                accountBalances.set(preBalance.accountIndex.toString(), {
                    exists: true,
                    isATA: true,
                    preBalance: Number(preBalance.uiTokenAmount.uiAmount || 0),
                    postBalance: postBalance ? Number(postBalance.uiTokenAmount.uiAmount || 0) : 0,
                    decimals: preBalance.uiTokenAmount.decimals,
                    mint: preBalance.mint
                });
            }
            const poolBalances = {
                coin: { pre: 0, post: 0, decimals: 0 },
                pc: { pre: 0, post: 0, decimals: 0 }
            };
            const accounts = tx.transaction?.transaction?.message?.accountKeys;
            const instructions = tx.transaction?.transaction?.message?.instructions;
            const raydiumInstruction = instructions?.find((ix) => {
                const programId = accounts[ix.programIdIndex];
                return ((programId instanceof Uint8Array || programId?.type === 'Buffer') &&
                    new web3_js_1.PublicKey(programId).equals(constants_1.RAYDIUM_AMM_PROGRAM_ID));
            });
            if (raydiumInstruction) {
                const poolCoinIndex = raydiumInstruction.accounts[5];
                const poolPcIndex = raydiumInstruction.accounts[6];
                const coinPreBalance = preBalances.find(b => b.accountIndex === poolCoinIndex);
                const coinPostBalance = postBalances.find(b => b.accountIndex === poolCoinIndex);
                const pcPreBalance = preBalances.find(b => b.accountIndex === poolPcIndex);
                const pcPostBalance = postBalances.find(b => b.accountIndex === poolPcIndex);
                if (coinPreBalance) {
                    poolBalances.coin = {
                        pre: Number(coinPreBalance.uiTokenAmount.uiAmount || 0),
                        post: coinPostBalance ? Number(coinPostBalance.uiTokenAmount.uiAmount || 0) : 0,
                        decimals: coinPreBalance.uiTokenAmount.decimals
                    };
                }
                if (pcPreBalance) {
                    poolBalances.pc = {
                        pre: Number(pcPreBalance.uiTokenAmount.uiAmount || 0),
                        post: pcPostBalance ? Number(pcPostBalance.uiTokenAmount.uiAmount || 0) : 0,
                        decimals: pcPreBalance.uiTokenAmount.decimals
                    };
                }
            }
            return {
                userAccounts: accountBalances,
                poolBalances,
                signature: tx.transaction.signature,
                slot: tx.slot,
                accountExists: {
                    hasSourceAccount: accountBalances.has(poolAccounts.poolCoinTokenAccount.toString()),
                    hasDestAccount: accountBalances.has(poolAccounts.poolPcTokenAccount.toString())
                }
            };
        }
        catch (error) {
            this.systemLogger.error('TransactionMonitor', 'Error extracting swap details', error);
            return null;
        }
    }
    // -------------------------------------------------------------------------
    // TOKEN CHANGES
    // -------------------------------------------------------------------------
    calculateTokenChanges(preBalances, postBalances) {
        try {
            const changes = new Map();
            for (const post of postBalances) {
                const pre = preBalances.find(p => p.accountIndex === post.accountIndex);
                if (!pre || pre.mint !== post.mint)
                    continue;
                const preAmount = Number(pre.uiTokenAmount.uiAmount || 0);
                const postAmount = Number(post.uiTokenAmount.uiAmount || 0);
                const change = postAmount - preAmount;
                changes.set(post.mint, {
                    totalChange: change,
                    decimals: post.uiTokenAmount.decimals,
                    preAmount,
                    postAmount
                });
            }
            const tokenEntry = Array.from(changes.entries()).find(([mint]) => mint !== spl_token_1.NATIVE_MINT.toString());
            if (!tokenEntry)
                return null;
            const [mint, data] = tokenEntry;
            const tokenMint = new web3_js_1.PublicKey(mint);
            const wsol = changes.get(spl_token_1.NATIVE_MINT.toString());
            const token = changes.get(mint);
            const isBuy = (wsol?.totalChange || 0) < 0 && (token?.totalChange || 0) > 0;
            const tokenChange = Math.abs(token?.totalChange || 0);
            const wsolChange = Math.abs(wsol?.totalChange || 0);
            return {
                tokenMint,
                tokenIn: isBuy ? spl_token_1.NATIVE_MINT.toString() : mint,
                tokenOut: isBuy ? mint : spl_token_1.NATIVE_MINT.toString(),
                amountIn: isBuy ? wsolChange : tokenChange,
                amountOut: isBuy ? tokenChange : wsolChange,
                decimalsIn: isBuy ? wsol?.decimals : token?.decimals,
                decimalsOut: isBuy ? token?.decimals : wsol?.decimals
            };
        }
        catch (error) {
            this.systemLogger.error('TransactionMonitor', 'Error calculating token changes', error);
            return null;
        }
    }
    // -------------------------------------------------------------------------
    // DETECT RAYDIUM SWAP DIRECTION
    // -------------------------------------------------------------------------
    detectSwapDirection(preBalances, postBalances, poolBalances) {
        const coinChange = poolBalances.coin.post - poolBalances.coin.pre;
        const pcChange = poolBalances.pc.post - poolBalances.pc.pre;
        if (coinChange < 0 && pcChange > 0)
            return 'sell';
        if (coinChange > 0 && pcChange < 0)
            return 'buy';
        const wsolChanges = this.calculateTokenChange(preBalances, postBalances, spl_token_1.NATIVE_MINT.toString());
        return wsolChanges < 0 ? 'buy' : 'sell';
    }
    calculateTokenChange(preBalances, postBalances, mintAddress) {
        const pre = preBalances
            .filter(b => b.mint === mintAddress)
            .reduce((sum, b) => sum + Number(b.uiTokenAmount.uiAmount || 0), 0);
        const post = postBalances
            .filter(b => b.mint === mintAddress)
            .reduce((sum, b) => sum + Number(b.uiTokenAmount.uiAmount || 0), 0);
        return post - pre;
    }
    // -------------------------------------------------------------------------
    // UTILITIES
    // -------------------------------------------------------------------------
    getStatus() {
        return { ...this.status };
    }
    async extractWalletAddress(tx) {
        try {
            const accountKeys = tx.transaction?.transaction?.message?.accountKeys;
            if (!accountKeys || !Array.isArray(accountKeys) || accountKeys.length === 0) {
                return undefined;
            }
            const firstKey = accountKeys[0];
            if (firstKey instanceof Uint8Array) {
                return bs58_1.default.encode(firstKey);
            }
            else if (firstKey.type === 'Buffer' && Array.isArray(firstKey.data)) {
                return bs58_1.default.encode(Buffer.from(firstKey.data));
            }
            return undefined;
        }
        catch (error) {
            this.systemLogger.error('TransactionMonitor', 'Error extracting wallet address', error);
            return undefined;
        }
    }
    addWallet(address) {
        if (!address.match(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/)) {
            throw new Error(`Invalid wallet address: ${address}`);
        }
        if (!this.config.wallets.includes(address)) {
            this.config.wallets.push(address);
            this.walletSet.add(address);
            if (this.status.isActive) {
                this.systemLogger.info('TransactionMonitor', 'Restarting monitor to include new wallet');
                this.stop().then(() => this.start());
            }
        }
    }
    removeWallet(address) {
        const index = this.config.wallets.indexOf(address);
        if (index !== -1) {
            this.config.wallets.splice(index, 1);
            this.walletSet.delete(address);
            if (this.status.isActive) {
                this.systemLogger.info('TransactionMonitor', 'Restarting monitor after wallet removal');
                this.stop().then(() => this.start());
            }
        }
    }
}
exports.TransactionMonitor = TransactionMonitor;
