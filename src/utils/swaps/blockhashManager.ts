//blockhashManager.ts
import { Connection } from "@solana/web3.js";
import chalk = require("chalk");
import { COLORS } from "../../cli/config";

interface BlockhashInfo {
    blockhash: string;
    lastValidBlockHeight: number;
    timestamp: number;
}

export class BlockhashManager {
    private static instance: BlockhashManager;
    private connection: Connection | null = null;
    private currentBlockhashInfo: BlockhashInfo | null = null;
    private updateInterval: NodeJS.Timeout | null = null;  // Changed from Timer to Timeout
    private REFRESH_INTERVAL = 30000; // 30 seconds
    private VALIDITY_THRESHOLD = 45000; // 45 seconds

    private constructor() {}

    public static getInstance(): BlockhashManager {
        if (!BlockhashManager.instance) {
            BlockhashManager.instance = new BlockhashManager();
        }
        return BlockhashManager.instance;
    }

    public initialize(connection: Connection) {
        this.connection = connection;
        this.startBackgroundUpdate();
    }

    private async updateBlockhash() {
        if (!this.connection) return;

        try {
            const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash("processed");
            this.currentBlockhashInfo = {
                blockhash,
                lastValidBlockHeight,
                timestamp: Date.now()
            };
        } catch (error) {
            console.warn("Failed to update blockhash:", error);
        }
    }

    private startBackgroundUpdate() {
        if (this.updateInterval) {
            clearInterval(this.updateInterval);
        }

        // Initial update
        this.updateBlockhash();

        // Set up periodic updates
        this.updateInterval = setInterval(() => {
            this.updateBlockhash();
        }, this.REFRESH_INTERVAL);
    }

    public async getBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number }> {
        if (!this.connection) {
            throw new Error(chalk.hex(COLORS.ERROR)("BlockhashManager not initialized"));
        }

        // If we have a recent blockhash, use it
        if (this.currentBlockhashInfo && 
            Date.now() - this.currentBlockhashInfo.timestamp < this.VALIDITY_THRESHOLD) {
            return {
                blockhash: this.currentBlockhashInfo.blockhash,
                lastValidBlockHeight: this.currentBlockhashInfo.lastValidBlockHeight
            };
        }

        // If blockhash is too old or doesn't exist, fetch a new one
        await this.updateBlockhash();
        if (!this.currentBlockhashInfo) {
            throw new Error(chalk.hex(COLORS.ERROR)("Failed to get blockhash"));
        }

        return {
            blockhash: this.currentBlockhashInfo.blockhash,
            lastValidBlockHeight: this.currentBlockhashInfo.lastValidBlockHeight
        };
    }

    public cleanup() {
        if (this.updateInterval) {
            clearInterval(this.updateInterval);
            this.updateInterval = null;
        }
    }
}