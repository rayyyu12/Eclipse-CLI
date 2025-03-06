// src/utils/positions/tokenBalanceMonitor.ts
import { Connection, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddress } from "@solana/spl-token";
import chalk from "chalk";
import { COLORS } from "../../cli/config";
import { PortfolioTracker } from "./portfolioTracker";

/**
 * A lightweight manager for token balance monitoring that integrates
 * with the more comprehensive PortfolioTracker.
 * 
 * This class primarily serves as a bridge and will be deprecated
 * in future versions as PortfolioTracker takes over its functionality.
 */
export class TokenBalanceMonitor {
    private static instance: TokenBalanceMonitor;
    private tracker: PortfolioTracker;
    private isInitialized: boolean = false;

    private constructor() {
        this.tracker = PortfolioTracker.getInstance();
    }

    public static getInstance(): TokenBalanceMonitor {
        if (!TokenBalanceMonitor.instance) {
            TokenBalanceMonitor.instance = new TokenBalanceMonitor();
        }
        return TokenBalanceMonitor.instance;
    }

    /**
     * Update a token balance manually when needed
     */
    public async updateTokenBalance(
        connection: Connection,
        walletPublicKey: PublicKey,
        tokenAddress: string
    ): Promise<void> {
        try {
            // Delegate to the enhanced Portfolio Tracker
            await this.tracker.refreshPosition(tokenAddress);
        } catch (error) {
            if (!(error instanceof Error) || !error.message.includes('429')) {
                console.error(`Error updating token balance for ${tokenAddress}:`, error);
            }
        }
    }

    /**
     * Initialize monitoring for all positions
     */
    public async monitorAllPositions(
        connection: Connection,
        walletPublicKey: PublicKey
    ): Promise<void> {
        if (this.isInitialized) return;
        
        try {
            // Initialize portfolio tracker first
            await this.tracker.initializeBalanceMonitoring();
            this.isInitialized = true;
        } catch (error) {
            console.error(chalk.hex(COLORS.ERROR)('Error initializing position monitoring:'), error);
            // Don't throw here to avoid breaking other functionality
        }
    }

    /**
     * Start monitoring a specific token
     */
    public async startMonitoring(
        connection: Connection, 
        walletPublicKey: PublicKey,
        tokenAddress: string
    ): Promise<void> {
        try {
            await this.tracker.startMonitoring(connection, walletPublicKey, tokenAddress);
        } catch (error) {
            console.error(chalk.hex(COLORS.ERROR)(`Error starting monitoring for ${tokenAddress}:`), error);
        }
    }

    /**
     * Handle a confirmed sell transaction
     */
    public async handleConfirmedSellTransaction(
        connection: Connection,
        walletPublicKey: PublicKey,
        tokenAddress: string
    ): Promise<void> {
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
        } catch (error) {
            console.error(chalk.hex(COLORS.ERROR)(`Error handling sell transaction for ${tokenAddress}:`), error);
        }
    }

    public async stopAllMonitoring(): Promise<void> {
        try {
            await this.tracker.cleanup();
            this.isInitialized = false;
        } catch (error) {
            console.error(chalk.hex(COLORS.ERROR)('Error stopping monitoring:'), error);
        }
    }
}