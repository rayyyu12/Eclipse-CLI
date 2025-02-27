"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.BlockhashManager = void 0;
const chalk_1 = __importDefault(require("chalk"));
const config_1 = require("../../cli/config");
/**
 * Manages blockhashes for the application to reduce redundant requests
 * and ensure recent blockhashes for transactions.
 */
class BlockhashManager {
    constructor() {
        this.connection = null;
        this.currentBlockhashInfo = null;
        this.updateInterval = null;
        this.blockhashPromise = null;
        this.lastError = null;
        // Configuration settings
        this.REFRESH_INTERVAL = 20000; // 20 seconds
        this.VALIDITY_THRESHOLD = 30000; // 30 seconds
        this.MAX_RETRIES = 3;
        this.RETRY_DELAY = 1000; // 1 second
    }
    static getInstance() {
        if (!BlockhashManager.instance) {
            BlockhashManager.instance = new BlockhashManager();
        }
        return BlockhashManager.instance;
    }
    /**
     * Initialize the BlockhashManager with a connection
     */
    initialize(connection) {
        this.connection = connection;
        this.startBackgroundUpdate();
    }
    /**
     * Update the cached blockhash
     */
    async updateBlockhash() {
        if (!this.connection) {
            // Return a fake blockhash if we have a previous one
            if (this.currentBlockhashInfo) {
                console.warn(chalk_1.default.hex(config_1.COLORS.ERROR)("BlockhashManager not initialized, using previous blockhash"));
                return this.currentBlockhashInfo;
            }
            throw new Error(chalk_1.default.hex(config_1.COLORS.ERROR)("BlockhashManager not initialized"));
        }
        let attempt = 0;
        let lastError = null;
        while (attempt < this.MAX_RETRIES) {
            try {
                const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash({
                    commitment: "processed"
                });
                const info = {
                    blockhash,
                    lastValidBlockHeight,
                    timestamp: Date.now()
                };
                this.currentBlockhashInfo = info;
                this.lastError = null; // Clear any previous errors
                return info;
            }
            catch (error) {
                lastError = error;
                attempt++;
                if (attempt < this.MAX_RETRIES) {
                    await new Promise(resolve => setTimeout(resolve, this.RETRY_DELAY));
                }
            }
        }
        // Instead of throwing, return a fake/placeholder blockhash when all attempts fail
        if (this.currentBlockhashInfo) {
            console.warn(chalk_1.default.hex(config_1.COLORS.ERROR)("Failed to update blockhash, using previous one"));
            this.lastError = lastError;
            return this.currentBlockhashInfo;
        }
        // Only throw if we have no fallback option
        this.lastError = lastError;
        throw lastError || new Error(chalk_1.default.hex(config_1.COLORS.ERROR)("Failed to update blockhash"));
    }
    /**
     * Start periodic background updates
     */
    startBackgroundUpdate() {
        if (this.updateInterval) {
            clearInterval(this.updateInterval);
        }
        // Initial update (don't await here to avoid blocking)
        this.blockhashPromise = this.updateBlockhash().catch(error => {
            console.warn(chalk_1.default.hex(config_1.COLORS.ERROR)("Initial blockhash update failed:"), error.message);
            // Return fake blockhash if we have nothing
            if (this.currentBlockhashInfo) {
                return this.currentBlockhashInfo;
            }
            // Create a placeholder blockhash if we have absolutely nothing
            return {
                blockhash: "GfSPV3WrqvEVuPAuGf5JYfecFiRCGR8MmAh5n1GT4ks8",
                lastValidBlockHeight: 0,
                timestamp: Date.now()
            };
        });
        // Set up periodic updates
        this.updateInterval = setInterval(() => {
            // Only update if not currently updating
            if (!this.blockhashPromise) {
                this.blockhashPromise = this.updateBlockhash().catch(error => {
                    console.warn(chalk_1.default.hex(config_1.COLORS.ERROR)("Background blockhash update failed:"), error.message);
                    // Return existing hash if available, otherwise rethrow
                    if (this.currentBlockhashInfo) {
                        return this.currentBlockhashInfo;
                    }
                    throw error;
                }).finally(() => {
                    this.blockhashPromise = null;
                });
            }
        }, this.REFRESH_INTERVAL);
    }
    /**
     * Get the current blockhash, fetching a new one if necessary
     */
    async getBlockhash() {
        if (!this.connection) {
            // Return a fake blockhash if we have a previous one
            if (this.currentBlockhashInfo) {
                console.warn(chalk_1.default.hex(config_1.COLORS.ERROR)("BlockhashManager not initialized, using cached blockhash"));
                return {
                    blockhash: this.currentBlockhashInfo.blockhash,
                    lastValidBlockHeight: this.currentBlockhashInfo.lastValidBlockHeight
                };
            }
            console.warn(chalk_1.default.hex(config_1.COLORS.ERROR)("BlockhashManager not initialized, using placeholder blockhash"));
            // Provide a dummy blockhash to prevent total failure
            return {
                blockhash: "GfSPV3WrqvEVuPAuGf5JYfecFiRCGR8MmAh5n1GT4ks8",
                lastValidBlockHeight: 0
            };
        }
        // If we have a recent blockhash, use it
        if (this.currentBlockhashInfo &&
            Date.now() - this.currentBlockhashInfo.timestamp < this.VALIDITY_THRESHOLD) {
            return {
                blockhash: this.currentBlockhashInfo.blockhash,
                lastValidBlockHeight: this.currentBlockhashInfo.lastValidBlockHeight
            };
        }
        // If we're currently fetching a blockhash, wait for it
        if (this.blockhashPromise) {
            try {
                const result = await this.blockhashPromise;
                return {
                    blockhash: result.blockhash,
                    lastValidBlockHeight: result.lastValidBlockHeight
                };
            }
            catch (error) {
                // If the existing promise failed, start a new one
                this.blockhashPromise = null;
                // Use the previous blockhash if available
                if (this.currentBlockhashInfo) {
                    console.warn(chalk_1.default.hex(config_1.COLORS.ERROR)("Blockhash fetch failed, using previous blockhash"));
                    return {
                        blockhash: this.currentBlockhashInfo.blockhash,
                        lastValidBlockHeight: this.currentBlockhashInfo.lastValidBlockHeight
                    };
                }
            }
        }
        // If blockhash is too old or doesn't exist, fetch a new one
        try {
            this.blockhashPromise = this.updateBlockhash();
            const result = await this.blockhashPromise;
            this.blockhashPromise = null;
            return {
                blockhash: result.blockhash,
                lastValidBlockHeight: result.lastValidBlockHeight
            };
        }
        catch (error) {
            this.blockhashPromise = null;
            // Last resort: if we have a previous blockhash, use it
            if (this.currentBlockhashInfo) {
                console.warn(chalk_1.default.hex(config_1.COLORS.ERROR)("Blockhash fetch failed, using previous blockhash"));
                return {
                    blockhash: this.currentBlockhashInfo.blockhash,
                    lastValidBlockHeight: this.currentBlockhashInfo.lastValidBlockHeight
                };
            }
            // If all else fails, provide a dummy blockhash
            console.warn(chalk_1.default.hex(config_1.COLORS.ERROR)("All blockhash fetches failed, using placeholder"));
            return {
                blockhash: "GfSPV3WrqvEVuPAuGf5JYfecFiRCGR8MmAh5n1GT4ks8",
                lastValidBlockHeight: 0
            };
        }
    }
    /**
     * Get the latest error that occurred during blockhash fetching
     */
    getLastError() {
        return this.lastError;
    }
    /**
     * Clean up resources
     */
    cleanup() {
        if (this.updateInterval) {
            clearInterval(this.updateInterval);
            this.updateInterval = null;
        }
        this.blockhashPromise = null;
    }
}
exports.BlockhashManager = BlockhashManager;
// Adding a property to track promise state (not standard, but useful)
Object.defineProperty(Promise.prototype, 'isFulfilled', {
    get: function () {
        // @ts-ignore: We need to access internal state
        return this._state === 'fulfilled';
    },
});
