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
exports.PortfolioTracker = exports.webhookURL = void 0;
const web3_js_1 = require("@solana/web3.js");
const spl_token_1 = require("@solana/spl-token");
const pumpSwap_1 = require("../swaps/pumpSwap");
const credentialsManager_1 = require("../../cli/utils/credentialsManager");
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const axios_1 = __importDefault(require("axios"));
const bn_js_1 = __importDefault(require("bn.js"));
const chalk_1 = __importDefault(require("chalk"));
const config_1 = require("../../cli/config");
const events_1 = require("events");
const js_1 = require("@metaplex-foundation/js");
const logger_1 = require("../../cli/utils/logger");
exports.webhookURL = '';
const logger = logger_1.Logger.getInstance();
/**
 * Enhanced PortfolioTracker with integrated balance monitoring
 */
class PortfolioTracker extends events_1.EventEmitter {
    constructor() {
        super();
        this.isInitialized = false;
        this.initializationPromise = null;
        this.lastSolPrice = 0;
        this.lastSolPriceTimestamp = 0;
        // Caches and flags for token metadata fetching
        this.tokenMetadataCache = new Map();
        this.trackedPositions = new Map();
        this.currentBalances = new Map();
        this.accountSubscriptions = new Map();
        this.positionsFile = path_1.default.join(__dirname, '..', '..', 'portfolio-positions.json');
        this.credManager = credentialsManager_1.CredentialsManager.getInstance();
        this.loadPositions();
    }
    static getInstance() {
        if (!PortfolioTracker.instance) {
            PortfolioTracker.instance = new PortfolioTracker();
        }
        return PortfolioTracker.instance;
    }
    /**
     * Main initialization method - only runs once, subsequent calls
     * return the same promise
     */
    async initializeBalanceMonitoring() {
        if (this.isInitialized) {
            return;
        }
        // If already initializing, return the existing promise
        if (this.initializationPromise) {
            return this.initializationPromise;
        }
        this.initializationPromise = this.doInitializeBalanceMonitoring();
        return this.initializationPromise;
    }
    /**
     * The actual implementation of the initialization
     * Protected by the public method to prevent multiple calls
     */
    async doInitializeBalanceMonitoring() {
        try {
            // Fetch initial balances for all tracked tokens
            const initialBalances = await this.fetchInitialBalances();
            // Set up monitoring for each token
            for (const [tokenAddress, data] of initialBalances.entries()) {
                await this.setupAccountMonitoring(this.credManager.getConnection(), data.accountAddress, tokenAddress, data.decimals);
                // Update current balances map if needed
                if (!this.currentBalances.has(tokenAddress)) {
                    this.currentBalances.set(tokenAddress, {
                        currentTokens: data.balance,
                        lastKnownTokens: data.balance,
                        totalSold: 0,
                        totalBought: 0,
                        lastUpdated: Date.now()
                    });
                }
                else {
                    // Update existing balance info
                    const existing = this.currentBalances.get(tokenAddress);
                    existing.currentTokens = data.balance;
                    existing.lastKnownTokens = data.balance;
                    existing.lastUpdated = Date.now();
                    this.currentBalances.set(tokenAddress, existing);
                }
            }
            // Save initial portfolio state
            this.savePositions();
            // Mark as initialized
            this.isInitialized = true;
            this.emit('initialized');
        }
        catch (error) {
            // Only log truly fatal errors
            if (!(error instanceof Error) || !error.message.includes('429')) {
                logger.error('PortfolioTracker', 'Balance monitoring initialization failed', error);
            }
            // Reset initialization flag so it can be retried
            this.initializationPromise = null;
            throw error;
        }
    }
    /**
     * Fetches initial token balances for all tracked positions
     */
    async fetchInitialBalances() {
        const connection = this.credManager.getConnection();
        const wallet = this.credManager.getKeyPair();
        const balances = new Map();
        // Get all token accounts owned by wallet
        const tokenAccounts = await connection.getParsedTokenAccountsByOwner(wallet.publicKey, { programId: spl_token_1.TOKEN_PROGRAM_ID });
        // Process each token account
        for (const { pubkey, account } of tokenAccounts.value) {
            const parsedData = account.data;
            const tokenAddress = parsedData.parsed.info.mint;
            // Only track tokens that are in our positions
            if (this.trackedPositions.has(tokenAddress)) {
                const decimals = parsedData.parsed.info.tokenAmount.decimals;
                const rawBalance = parsedData.parsed.info.tokenAmount.amount;
                const adjustedBalance = Number(rawBalance) / Math.pow(10, decimals);
                balances.set(tokenAddress, {
                    balance: adjustedBalance,
                    decimals,
                    accountAddress: pubkey
                });
            }
        }
        return balances;
    }
    /**
     * Set up monitoring for a specific token account
     */
    async setupAccountMonitoring(connection, accountAddress, tokenAddress, decimals) {
        // Remove existing subscription if any
        const existingSubscription = this.accountSubscriptions.get(tokenAddress);
        if (existingSubscription) {
            await connection.removeAccountChangeListener(existingSubscription);
        }
        // Set up new subscription
        const subscriptionId = connection.onAccountChange(accountAddress, async (accountInfo, context) => {
            try {
                // Get updated balance
                const tokenAccount = await (0, spl_token_1.getAccount)(connection, accountAddress);
                const newBalance = Number(tokenAccount.amount) / Math.pow(10, decimals);
                // Get current token price
                const currentPrice = await this.getCurrentTokenPrice(tokenAddress);
                // Process the update
                await this.handleBalanceChange(tokenAddress, newBalance, currentPrice);
            }
            catch (error) {
                // Silently handle rate limits
                if (!(error instanceof Error) || !error.message.includes('429')) {
                    logger.error('PortfolioTracker', `Error processing account update for ${tokenAddress}`, error);
                }
            }
        }, 'confirmed');
        // Save subscription ID for cleanup
        this.accountSubscriptions.set(tokenAddress, subscriptionId);
    }
    /**
     * Handles detecting buy/sell changes in token balances and updates totalBought or totalSold accordingly
     */
    async handleBalanceChange(tokenAddress, newBalance, currentPrice) {
        const balanceInfo = this.currentBalances.get(tokenAddress);
        const position = this.trackedPositions.get(tokenAddress);
        if (!balanceInfo || !position)
            return;
        const oldBalance = balanceInfo.lastKnownTokens;
        const balanceDiff = newBalance - oldBalance;
        // Prevent same balance change from triggering multiple times
        if (Math.abs(newBalance - balanceInfo.currentTokens) < 0.000001)
            return;
        // Add timestamp-based deduplication (5 second window)
        if (Date.now() - balanceInfo.lastUpdated < 5000) {
            return;
        }
        if (balanceDiff < 0) {
            // SELL logic - token balance decreased
            const soldAmount = Math.abs(balanceDiff);
            const soldValue = soldAmount * currentPrice;
            // Only update and notify if there's a meaningful change
            if (soldValue > 0.0001) {
                balanceInfo.totalSold += soldValue;
                // Emit balance change event
                this.emit('balanceChange', {
                    tokenAddress,
                    oldBalance,
                    newBalance,
                    change: balanceDiff,
                    timestamp: new Date()
                });
                // Generate image and send to Discord for significant changes
                try {
                    const positionData = await this.getPosition(tokenAddress);
                    if (positionData) {
                        // Force update with fresh price
                        positionData.currentPriceSol = await this.getCurrentTokenPrice(tokenAddress);
                        positionData.pnlPercentage = ((positionData.currentPriceSol - positionData.entryPriceSol) /
                            positionData.entryPriceSol) * 100;
                        await this.sendPositionToDiscord(positionData);
                    }
                }
                catch (error) {
                    logger.error('PortfolioTracker', `Failed to generate position image for ${tokenAddress}`, error);
                }
            }
        }
        else if (balanceDiff > 0.000001) {
            // BUY logic - token balance increased
            const boughtAmount = balanceDiff;
            const boughtValue = boughtAmount * currentPrice;
            balanceInfo.totalBought += boughtValue;
            // Emit balance change event
            this.emit('balanceChange', {
                tokenAddress,
                oldBalance,
                newBalance,
                change: balanceDiff,
                timestamp: new Date()
            });
        }
        // Update the record of current tokens & last-known
        balanceInfo.currentTokens = newBalance;
        balanceInfo.lastKnownTokens = newBalance;
        balanceInfo.lastUpdated = Date.now();
        this.currentBalances.set(tokenAddress, balanceInfo);
        this.savePositions();
    }
    /**
     * Utility method to send position updates to Discord
     */
    async sendPositionToDiscord(position) {
        // Import the ImageGenerator dynamically to handle the case where Sharp might not be available
        try {
            // Try to use the SVG generator first (which doesn't depend on Sharp)
            let imageGenerator;
            try {
                const { ImageGenerator } = await Promise.resolve().then(() => __importStar(require('./imageGeneratorSvg')));
                imageGenerator = ImageGenerator.getInstance();
                // SVG generator can accept just the position
                await imageGenerator.sendToDiscord(position);
            }
            catch (error) {
                // Fall back to the original ImageGenerator if SVG one fails
                const { ImageGenerator } = await Promise.resolve().then(() => __importStar(require('./imageGenerator')));
                imageGenerator = ImageGenerator.getInstance();
                // Original generator requires generating the image buffer first
                const imageBuffer = await imageGenerator.generatePositionImage(position);
                await imageGenerator.sendToDiscord(imageBuffer, position);
            }
            logger.success('PortfolioTracker', `Position for ${position.symbol} sent to Discord`);
        }
        catch (error) {
            logger.error('PortfolioTracker', `Failed to send position for ${position.symbol} to Discord`, error);
        }
    }
    /**
     * Explicitly initialize monitoring for a specific token
     * Called after buy transactions or when adding a new position
     */
    async initializeTokenMonitoring(tokenAddress) {
        const connection = this.credManager.getConnection();
        const wallet = this.credManager.getKeyPair();
        try {
            const tokenMint = new web3_js_1.PublicKey(tokenAddress);
            const tokenAccount = await (0, spl_token_1.getAssociatedTokenAddress)(tokenMint, wallet.publicKey, false);
            // Get token account info
            const mintInfo = await connection.getParsedAccountInfo(tokenMint);
            const decimals = (mintInfo.value?.data).parsed.info.decimals || 9;
            try {
                const accountInfo = await (0, spl_token_1.getAccount)(connection, tokenAccount);
                const currentTokens = Number(accountInfo.amount) / Math.pow(10, decimals);
                // Update local record
                const existingBalance = this.currentBalances.get(tokenAddress) ?? {
                    currentTokens: 0,
                    lastKnownTokens: 0,
                    totalSold: 0,
                    totalBought: 0,
                    lastUpdated: 0
                };
                existingBalance.currentTokens = currentTokens;
                existingBalance.lastKnownTokens = currentTokens;
                existingBalance.lastUpdated = Date.now();
                this.currentBalances.set(tokenAddress, existingBalance);
                // Setup real-time subscription
                await this.setupAccountMonitoring(connection, tokenAccount, tokenAddress, decimals);
            }
            catch (error) {
                // If token account doesn't exist yet, that's okay - just skip monitoring setup
                logger.info('PortfolioTracker', `Token account for ${tokenAddress} doesn't exist yet`);
            }
        }
        catch (error) {
            logger.error('PortfolioTracker', `Error initializing monitoring for ${tokenAddress}`, error);
            throw error;
        }
    }
    /**
     * Initialize monitoring for a newly bought token
     */
    async startMonitoring(connection, walletPublicKey, tokenAddress) {
        // First ensure the portfolio tracker is initialized
        await this.initializeBalanceMonitoring();
        // Now start monitoring this specific token
        await this.initializeTokenMonitoring(tokenAddress);
    }
    /**
     * Clean up all subscriptions - call this when shutting down
     */
    async cleanup() {
        const connection = this.credManager.getConnection();
        // Clean up all subscriptions
        for (const [tokenAddress, subscriptionId] of this.accountSubscriptions.entries()) {
            try {
                await connection.removeAccountChangeListener(subscriptionId);
            }
            catch (error) {
                logger.warn('PortfolioTracker', `Error removing listener for ${tokenAddress}`, error);
            }
        }
        this.accountSubscriptions.clear();
        this.savePositions(); // Save one last time
    }
    /**
     * Load positions from disk
     */
    loadPositions() {
        try {
            if (fs_1.default.existsSync(this.positionsFile)) {
                const fileContent = fs_1.default.readFileSync(this.positionsFile, 'utf8');
                if (fileContent.trim()) {
                    const parsed = JSON.parse(fileContent);
                    for (const [tokenAddress, data] of Object.entries(parsed)) {
                        // Validate the data before adding it
                        if (!this.validatePositionData(data)) {
                            logger.warn('PortfolioTracker', `Invalid position data for ${tokenAddress}, skipping`);
                            continue;
                        }
                        this.trackedPositions.set(tokenAddress, {
                            ...data.position,
                            initialBuyAmount: Number(data.position.initialBuyAmount),
                            initialSolSpent: Number(data.position.initialSolSpent),
                            entryPrice: Number(data.position.entryPrice)
                        });
                        if (data.balanceInfo) {
                            this.currentBalances.set(tokenAddress, {
                                currentTokens: Number(data.balanceInfo.currentTokens),
                                lastKnownTokens: Number(data.balanceInfo.lastKnownTokens),
                                totalSold: Number(data.balanceInfo.totalSold || 0),
                                totalBought: Number(data.balanceInfo.totalBought || 0),
                                lastUpdated: data.balanceInfo.lastUpdated
                            });
                        }
                    }
                }
                else {
                    this.trackedPositions = new Map();
                    this.currentBalances = new Map();
                    fs_1.default.writeFileSync(this.positionsFile, JSON.stringify({}));
                }
            }
        }
        catch (error) {
            logger.error('PortfolioTracker', 'Error loading positions', error);
            this.trackedPositions = new Map();
            this.currentBalances = new Map();
            fs_1.default.writeFileSync(this.positionsFile, JSON.stringify({}));
        }
    }
    /**
     * Validate position data before loading it
     */
    validatePositionData(data) {
        if (!data || typeof data !== 'object')
            return false;
        // Check position data
        if (!data.position || typeof data.position !== 'object')
            return false;
        if (typeof data.position.tokenAddress !== 'string')
            return false;
        if (isNaN(Number(data.position.initialBuyAmount)))
            return false;
        if (isNaN(Number(data.position.initialSolSpent)))
            return false;
        if (isNaN(Number(data.position.entryPrice)))
            return false;
        // Check balance info
        if (!data.balanceInfo || typeof data.balanceInfo !== 'object')
            return false;
        if (isNaN(Number(data.balanceInfo.currentTokens)))
            return false;
        if (isNaN(Number(data.balanceInfo.lastKnownTokens)))
            return false;
        return true;
    }
    /**
     * Save positions to disk
     */
    savePositions() {
        try {
            const data = {};
            this.trackedPositions.forEach((position, tokenAddress) => {
                data[tokenAddress] = {
                    position: {
                        ...position,
                        initialBuyAmount: Number(position.initialBuyAmount),
                        initialSolSpent: Number(position.initialSolSpent),
                        entryPrice: Number(position.entryPrice)
                    },
                    balanceInfo: this.currentBalances.get(tokenAddress)
                };
            });
            fs_1.default.writeFileSync(this.positionsFile, JSON.stringify(data, null, 2));
        }
        catch (error) {
            logger.error('PortfolioTracker', 'Error saving positions', error);
        }
    }
    /**
     * Get the current SOL price in USD from Jupiter with caching
     */
    async getSolPriceUsd() {
        // Use cached price if it's less than 5 minutes old
        const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes in milliseconds
        if (this.lastSolPrice > 0 &&
            (Date.now() - this.lastSolPriceTimestamp) < CACHE_DURATION) {
            return this.lastSolPrice;
        }
        try {
            const solResponse = await axios_1.default.get('https://api.jup.ag/price/v2?ids=So11111111111111111111111111111111111111112');
            const solData = solResponse.data.data['So11111111111111111111111111111111111111112'];
            const price = Number(solData.price) || 0;
            // Cache the price
            this.lastSolPrice = price;
            this.lastSolPriceTimestamp = Date.now();
            return price;
        }
        catch (error) {
            logger.warn('PortfolioTracker', 'Error fetching SOL price', error);
            // Return cached price if available, otherwise 0
            return this.lastSolPrice || 0;
        }
    }
    /**
     * Fetch the token metadata using Metaplex, then fallback to basic text if it fails
     */
    async getTokenMetadata(tokenAddress) {
        const cached = this.tokenMetadataCache.get(tokenAddress);
        if (cached)
            return cached;
        const connection = this.credManager.getConnection();
        const metaplex = js_1.Metaplex.make(connection);
        try {
            const mintPubKey = new web3_js_1.PublicKey(tokenAddress);
            const tokenData = await metaplex.nfts().findByMint({
                mintAddress: mintPubKey
            });
            const metadata = {
                name: tokenData.name.trim() || 'Unknown Token',
                // prepend $ to symbol for clarity
                symbol: `$${tokenData.symbol.trim()}` || `$${tokenAddress.slice(0, 4)}...${tokenAddress.slice(-4)}`
            };
            this.tokenMetadataCache.set(tokenAddress, metadata);
            return metadata;
        }
        catch (error) {
            // Fallback metadata with $ prefix
            const fallbackMeta = {
                symbol: `$${tokenAddress.slice(0, 4)}...${tokenAddress.slice(-4)}`,
                name: 'Unknown Token'
            };
            this.tokenMetadataCache.set(tokenAddress, fallbackMeta);
            return fallbackMeta;
        }
    }
    async getPumpTokenData(tokenAddress) {
        try {
            const response = await axios_1.default.get(`https://frontend-api.pump.fun/coins/${tokenAddress}`, {
                headers: {
                    "User-Agent": "Mozilla/5.0",
                    "Accept": "*/*",
                    "Referer": "https://www.pump.fun/",
                    "Origin": "https://www.pump.fun"
                }
            });
            if (response.status === 404)
                return null;
            const data = response.data;
            if (!data.bonding_curve || !data.associated_bonding_curve)
                return null;
            return data;
        }
        catch (error) {
            return null;
        }
    }
    calculatePumpTokenPrice(coinData) {
        try {
            const virtualTokenReserves = new bn_js_1.default(coinData.virtual_token_reserves);
            const virtualSolReserves = new bn_js_1.default(coinData.virtual_sol_reserves);
            if (virtualTokenReserves.isZero() || virtualSolReserves.isZero())
                return 0;
            const reserves_ratio = Number(virtualSolReserves.toString()) / Number(virtualTokenReserves.toString());
            return reserves_ratio / 1000;
        }
        catch (error) {
            return 0;
        }
    }
    async getJupiterPrice(tokenAddress) {
        try {
            // 1) Fetch SOL price in USD
            const solResponse = await axios_1.default.get('https://api.jup.ag/price/v2?ids=So11111111111111111111111111111111111111112');
            const solPriceUSD = Number(solResponse.data.data.So11111111111111111111111111111111111111112.price);
            // 2) Fetch TOKEN price in USD
            const tokenResponse = await axios_1.default.get(`https://api.jup.ag/price/v2?ids=${tokenAddress}`);
            const tokenData = tokenResponse.data.data[tokenAddress];
            if (!tokenData)
                return 0;
            const tokenPriceUSD = Number(tokenData.price) || 0;
            // Return price in SOL (tokenPriceUSD / solPriceUSD)
            return tokenPriceUSD / solPriceUSD;
        }
        catch (error) {
            return 0;
        }
    }
    /**
     * Get current token price - handles both pump tokens and regular tokens
     */
    async getCurrentTokenPrice(tokenAddress) {
        try {
            const connection = this.credManager.getConnection();
            const tokenStatus = await (0, pumpSwap_1.isPumpFunToken)(connection, tokenAddress);
            if (tokenStatus.isPump) {
                const pumpData = await this.getPumpTokenData(tokenAddress);
                if (pumpData) {
                    return this.calculatePumpTokenPrice(pumpData);
                }
            }
            return await this.getJupiterPrice(tokenAddress);
        }
        catch (error) {
            // Fail silently and return 0 for price
            return 0;
        }
    }
    /**
     * Add a new position or update an existing one
     */
    async addPosition(tokenAddress, solSpent, amount, txId, options = {}) {
        // Initialize if not already done
        if (!this.isInitialized) {
            await this.initializeBalanceMonitoring();
        }
        const existingPosition = this.trackedPositions.get(tokenAddress);
        const existingBalance = this.currentBalances.get(tokenAddress);
        if (existingPosition) {
            // Update lastUpdated
            if (existingBalance) {
                existingBalance.lastUpdated = Date.now();
            }
        }
        else {
            // Brand new position
            const position = {
                tokenAddress,
                initialBuyAmount: amount,
                initialSolSpent: solSpent,
                entryPrice: options.entryPriceOverride ?? (solSpent / amount),
                timestamp: Date.now(),
                txId,
                isPumpToken: options.isPumpToken
            };
            this.trackedPositions.set(tokenAddress, position);
            this.currentBalances.set(tokenAddress, {
                currentTokens: amount,
                lastKnownTokens: amount,
                totalSold: 0,
                totalBought: 0,
                lastUpdated: Date.now()
            });
        }
        this.savePositions();
        await this.initializeTokenMonitoring(tokenAddress);
    }
    /**
     * Force refresh a specific position's data
     */
    async refreshPosition(tokenAddress) {
        // Skip if we're not tracking this position
        if (!this.trackedPositions.has(tokenAddress)) {
            return;
        }
        try {
            await this.initializeTokenMonitoring(tokenAddress);
            // Force update the position data with fresh price
            const position = await this.getPosition(tokenAddress);
            if (position) {
                const fresh = await this.getCurrentTokenPrice(tokenAddress);
                position.currentPriceSol = fresh;
                position.pnlPercentage = ((fresh - position.entryPriceSol) / position.entryPriceSol) * 100;
            }
        }
        catch (error) {
            logger.error('PortfolioTracker', `Error refreshing position for ${tokenAddress}`, error);
        }
    }
    /**
     * Get position data for a specific token
     */
    async getPosition(tokenAddress) {
        // Initialize if needed
        if (!this.isInitialized) {
            try {
                await this.initializeBalanceMonitoring();
            }
            catch (error) {
                logger.error('PortfolioTracker', `Failed to initialize for getPosition(${tokenAddress})`, error);
            }
        }
        const position = this.trackedPositions.get(tokenAddress);
        if (!position)
            return null;
        try {
            const currentPrice = await this.getCurrentTokenPrice(tokenAddress);
            const balanceInfo = this.currentBalances.get(tokenAddress);
            // If no record of balance, fetch on-the-fly
            if (!balanceInfo) {
                const connection = this.credManager.getConnection();
                const wallet = this.credManager.getKeyPair();
                const tokenAccount = await (0, spl_token_1.getAssociatedTokenAddress)(new web3_js_1.PublicKey(tokenAddress), wallet.publicKey);
                try {
                    const accountInfo = await (0, spl_token_1.getAccount)(connection, tokenAccount);
                    const mintInfo = await connection.getParsedAccountInfo(new web3_js_1.PublicKey(tokenAddress));
                    const decimals = (mintInfo.value?.data).parsed.info.decimals || 9;
                    const currentTokens = Number(accountInfo.amount) / Math.pow(10, decimals);
                    this.currentBalances.set(tokenAddress, {
                        currentTokens,
                        lastKnownTokens: currentTokens,
                        totalSold: 0,
                        totalBought: 0,
                        lastUpdated: Date.now()
                    });
                }
                catch (error) {
                    // If token account doesn't exist, create a placeholder
                    this.currentBalances.set(tokenAddress, {
                        currentTokens: 0,
                        lastKnownTokens: 0,
                        totalSold: 0,
                        totalBought: 0,
                        lastUpdated: Date.now()
                    });
                }
            }
            const finalBalance = this.currentBalances.get(tokenAddress);
            // Even if we have 0 tokens, we still want to show sold amounts, so do NOT return null
            const currentValue = finalBalance.currentTokens * currentPrice;
            const totalValueBought = position.initialSolSpent + finalBalance.totalBought;
            // Avoid divide by zero
            const pnlPercentage = position.entryPrice > 0
                ? ((currentPrice - position.entryPrice) / position.entryPrice) * 100
                : 0;
            const tokenMetadata = await this.getTokenMetadata(tokenAddress);
            // Compute Net Profit in SOL and USD
            const netProfitSol = (currentValue + finalBalance.totalSold) - totalValueBought;
            const solPriceUsd = await this.getSolPriceUsd();
            const netProfitUsd = netProfitSol * solPriceUsd;
            return {
                tokenAddress,
                symbol: tokenMetadata.symbol,
                name: tokenMetadata.name,
                entryPriceSol: position.entryPrice,
                currentPriceSol: currentPrice,
                totalValueBought,
                totalValueSold: finalBalance.totalSold,
                remainingValue: currentValue,
                pnlPercentage,
                isPumpToken: position.isPumpToken ?? false,
                lastUpdated: Date.now(),
                netProfitSol,
                netProfitUsd
            };
        }
        catch (error) {
            logger.error('PortfolioTracker', `Error fetching position for ${tokenAddress}`, error);
            return null;
        }
    }
    /**
     * Get all positions with summary data
     */
    async getAllPositions() {
        // Initialize if needed
        if (!this.isInitialized) {
            try {
                await this.initializeBalanceMonitoring();
            }
            catch (error) {
                logger.error('PortfolioTracker', `Failed to initialize for getAllPositions()`, error);
            }
        }
        const positions = [];
        let totalValue = 0;
        let totalInvestment = 0;
        for (const tokenAddress of this.trackedPositions.keys()) {
            try {
                const pos = await this.getPosition(tokenAddress);
                if (pos) {
                    positions.push(pos);
                    totalValue += pos.remainingValue;
                    totalInvestment += pos.totalValueBought;
                }
            }
            catch (error) {
                logger.error('PortfolioTracker', `Error processing position for ${tokenAddress}`, error);
            }
        }
        const totalPnl = totalValue - totalInvestment;
        const totalPnlPercentage = totalInvestment > 0
            ? ((totalValue / totalInvestment) - 1) * 100
            : 0;
        return {
            positions,
            totalValue,
            totalPnl,
            totalPnlPercentage,
            lastUpdated: Date.now()
        };
    }
    /**
     * Display portfolio to console
     */
    async displayPortfolio(connection, walletPublicKey) {
        if (!connection || !walletPublicKey) {
            connection = this.credManager.getConnection();
            walletPublicKey = this.credManager.getKeyPair().publicKey;
        }
        try {
            // Initialize if needed
            if (!this.isInitialized) {
                await this.initializeBalanceMonitoring();
            }
            // Get position data
            const positions = await Promise.all(Array.from(this.trackedPositions.entries()).map(async ([tokenAddress]) => await this.getPosition(tokenAddress)));
            const activePositions = positions.filter((pos) => pos !== null);
            if (activePositions.length === 0) {
                console.log(chalk_1.default.hex(config_1.COLORS.PRIMARY)('\nNo active positions found.\n'));
                return;
            }
            console.log(chalk_1.default.hex(config_1.COLORS.PRIMARY)('\n=== Token Positions ===\n'));
            for (const pos of activePositions) {
                console.log(chalk_1.default.hex(config_1.COLORS.ACCENT)(`Token Address: ${pos.tokenAddress}`));
                console.log(`Symbol: ${pos.symbol}`);
                const formatPrice = (price) => pos.isPumpToken
                    ? price.toExponential(9)
                    : price.toFixed(9);
                console.log(`Entry Price: ${formatPrice(pos.entryPriceSol)} SOL`);
                console.log(`Current Price: ${formatPrice(pos.currentPriceSol)} SOL`);
                const formatSol = (amount) => amount < 0.001
                    ? amount.toFixed(6)
                    : amount.toFixed(4);
                console.log(`Total Invested: ${formatSol(pos.totalValueBought)} SOL`);
                console.log(`Total Sold: ${formatSol(pos.totalValueSold)} SOL`);
                console.log(`Remaining Value: ${formatSol(pos.remainingValue)} SOL`);
                const pnlColor = pos.pnlPercentage >= 0 ? config_1.COLORS.SUCCESS : config_1.COLORS.ERROR;
                console.log(chalk_1.default.hex(pnlColor)(`Total PNL: ${pos.pnlPercentage.toFixed(2)}%`));
                // Show netProfit in both SOL and USD
                const netProfitSolFmt = pos.netProfitSol?.toFixed(4) ?? '0.0000';
                const netProfitUsdFmt = pos.netProfitUsd?.toFixed(2) ?? '0.00';
                console.log(`Net Profit: ${netProfitSolFmt} SOL (~$${netProfitUsdFmt} USD)`);
                console.log(chalk_1.default.hex(config_1.COLORS.SECONDARY)('---'));
            }
            console.log(chalk_1.default.hex(config_1.COLORS.PRIMARY)(`\nLast Updated: ${new Date().toLocaleString()}\n`));
        }
        catch (error) {
            logger.error('PortfolioTracker', 'Error displaying portfolio', error);
            throw error;
        }
    }
    /**
     * Force portfolio export to Discord
     */
    async exportPortfolioToDiscord() {
        try {
            // Get all positions
            const positionData = await this.getAllPositions();
            // Skip if no positions
            if (positionData.positions.length === 0) {
                console.log(chalk_1.default.hex(config_1.COLORS.PRIMARY)('No positions to export'));
                return;
            }
            // Send each position to Discord
            for (const position of positionData.positions) {
                try {
                    await this.sendPositionToDiscord(position);
                    console.log(chalk_1.default.hex(config_1.COLORS.SUCCESS)(`Exported position for ${position.symbol} to Discord`));
                }
                catch (error) {
                    logger.error('PortfolioTracker', `Failed to export position for ${position.symbol}`, error);
                }
            }
        }
        catch (error) {
            logger.error('PortfolioTracker', 'Failed to export portfolio', error);
        }
    }
}
exports.PortfolioTracker = PortfolioTracker;
exports.default = PortfolioTracker;
