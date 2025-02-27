"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TokenBalanceMonitor = void 0;
const chalk_1 = __importDefault(require("chalk"));
const config_1 = require("../../cli/config");
const portfolioTracker_1 = require("./portfolioTracker");
/**
 * A lightweight manager for token balance monitoring that integrates
 * with the more comprehensive PortfolioTracker.
 *
 * This class primarily serves as a bridge and will be deprecated
 * in future versions as PortfolioTracker takes over its functionality.
 */
class TokenBalanceMonitor {
    constructor() {
        this.isInitialized = false;
        this.tracker = portfolioTracker_1.PortfolioTracker.getInstance();
    }
    static getInstance() {
        if (!TokenBalanceMonitor.instance) {
            TokenBalanceMonitor.instance = new TokenBalanceMonitor();
        }
        return TokenBalanceMonitor.instance;
    }
    /**
     * Update a token balance manually when needed
     */
    async updateTokenBalance(connection, walletPublicKey, tokenAddress) {
        try {
            // Delegate to the enhanced Portfolio Tracker
            await this.tracker.refreshPosition(tokenAddress);
        }
        catch (error) {
            if (!(error instanceof Error) || !error.message.includes('429')) {
                console.error(`Error updating token balance for ${tokenAddress}:`, error);
            }
        }
    }
    /**
     * Initialize monitoring for all positions
     */
    async monitorAllPositions(connection, walletPublicKey) {
        if (this.isInitialized)
            return;
        try {
            // Initialize portfolio tracker first
            await this.tracker.initializeBalanceMonitoring();
            this.isInitialized = true;
        }
        catch (error) {
            console.error(chalk_1.default.hex(config_1.COLORS.ERROR)('Error initializing position monitoring:'), error);
            // Don't throw here to avoid breaking other functionality
        }
    }
    /**
     * Start monitoring a specific token
     */
    async startMonitoring(connection, walletPublicKey, tokenAddress) {
        try {
            await this.tracker.startMonitoring(connection, walletPublicKey, tokenAddress);
        }
        catch (error) {
            console.error(chalk_1.default.hex(config_1.COLORS.ERROR)(`Error starting monitoring for ${tokenAddress}:`), error);
        }
    }
    /**
     * Handle a confirmed sell transaction
     */
    async handleConfirmedSellTransaction(connection, walletPublicKey, tokenAddress) {
        try {
            // Ensure the token is being monitored
            await this.startMonitoring(connection, walletPublicKey, tokenAddress);
            // Force refresh the position data
            await this.tracker.refreshPosition(tokenAddress);
            // Generate Discord notification
            const positionData = await this.tracker.getPosition(tokenAddress);
            if (positionData) {
                await this.tracker.exportPortfolioToDiscord();
            }
        }
        catch (error) {
            console.error(chalk_1.default.hex(config_1.COLORS.ERROR)(`Error handling sell transaction for ${tokenAddress}:`), error);
        }
    }
    /**
     * Stop monitoring all tokens
     */
    async stopAllMonitoring() {
        try {
            await this.tracker.cleanup();
            this.isInitialized = false;
        }
        catch (error) {
            console.error(chalk_1.default.hex(config_1.COLORS.ERROR)('Error stopping monitoring:'), error);
        }
    }
}
exports.TokenBalanceMonitor = TokenBalanceMonitor;
