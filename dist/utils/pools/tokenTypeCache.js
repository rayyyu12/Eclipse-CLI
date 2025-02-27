"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TokenTypeCache = void 0;
// src/utils/pools/tokenTypeCache.ts
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const web3_js_1 = require("@solana/web3.js");
const pumpSwap_1 = require("../swaps/pumpSwap");
const persistentPoolCache_1 = require("./persistentPoolCache");
const spl_token_1 = require("@solana/spl-token");
const poolDiscovery_1 = require("./poolDiscovery");
const chalk_1 = __importDefault(require("chalk"));
const config_1 = require("../../cli/config");
/**
 * Enhanced TokenTypeCache with asynchronous checking and reduced network requests.
 */
class TokenTypeCache {
    constructor() {
        this.maxAge = 24 * 60 * 60 * 1000; // 24 hours
        this.pendingChecks = new Map();
        this.filePath = path_1.default.join(process.cwd(), 'token-types-cache.json');
        this.cache = new Map();
        this.loadFromDisk();
    }
    static getInstance() {
        if (!TokenTypeCache.instance) {
            TokenTypeCache.instance = new TokenTypeCache();
        }
        return TokenTypeCache.instance;
    }
    loadFromDisk() {
        try {
            if (fs_1.default.existsSync(this.filePath)) {
                const data = JSON.parse(fs_1.default.readFileSync(this.filePath, 'utf8'));
                this.cache = new Map(Object.entries(data).map(([key, value]) => [key, value]));
                // Clean up stale entries
                const now = Date.now();
                let staleCount = 0;
                for (const [key, info] of this.cache.entries()) {
                    if (now - info.timestamp > this.maxAge) {
                        this.cache.delete(key);
                        staleCount++;
                    }
                }
                if (staleCount > 0) {
                    this.saveToDisk();
                }
            }
        }
        catch (error) {
            console.log('No existing token type cache found or invalid format');
            this.cache = new Map();
        }
    }
    saveToDisk() {
        try {
            const data = Object.fromEntries(this.cache);
            fs_1.default.writeFileSync(this.filePath, JSON.stringify(data, null, 2));
        }
        catch (error) {
            console.error('Error saving token type cache:', error);
        }
    }
    /**
     * Set token type information in the cache
     */
    setTokenType(address, type, hasRaydiumPool = false) {
        this.cache.set(address, {
            address,
            type,
            timestamp: Date.now(),
            hasRaydiumPool
        });
        this.saveToDisk();
    }
    /**
     * Get token type information from the cache
     */
    getTokenType(address) {
        const info = this.cache.get(address);
        // Return if found and not expired
        if (info && (Date.now() - info.timestamp) < this.maxAge) {
            return info;
        }
        return undefined;
    }
    /**
     * Check token type, using cache when possible and updating cache when needed.
     * This method doesn't block and returns a Promise.
     */
    async checkTokenType(connection, tokenAddress) {
        const addressStr = tokenAddress instanceof web3_js_1.PublicKey ?
            tokenAddress.toString() :
            tokenAddress;
        // Check if we already have a pending check for this token
        if (this.pendingChecks.has(addressStr)) {
            return this.pendingChecks.get(addressStr);
        }
        // Check cache first
        const cached = this.getTokenType(addressStr);
        if (cached) {
            return cached;
        }
        // If no cache hit, need to check token type
        const checkPromise = this.performTokenTypeCheck(connection, addressStr);
        this.pendingChecks.set(addressStr, checkPromise);
        try {
            const result = await checkPromise;
            return result;
        }
        finally {
            // Clean up pending check
            this.pendingChecks.delete(addressStr);
        }
    }
    /**
     * Perform the actual token type checking logic
     */
    async performTokenTypeCheck(connection, addressStr) {
        try {
            // Skip the expensive check for non-pump tokens (quick optimization)
            if (!addressStr.endsWith('pump')) {
                const result = {
                    address: addressStr,
                    type: 'regular',
                    timestamp: Date.now()
                };
                this.setTokenType(addressStr, 'regular');
                return result;
            }
            // Check if it's a pump token
            const tokenInfo = await (0, pumpSwap_1.isPumpFunToken)(connection, addressStr);
            if (!tokenInfo.isPump && !tokenInfo.hasMigrated) {
                // It's a regular token
                this.setTokenType(addressStr, 'regular');
                return {
                    address: addressStr,
                    type: 'regular',
                    timestamp: Date.now()
                };
            }
            if (tokenInfo.hasMigrated) {
                // It's a migrated pump token
                this.setTokenType(addressStr, 'migratedPump');
                return {
                    address: addressStr,
                    type: 'migratedPump',
                    timestamp: Date.now()
                };
            }
            // It's a pump token - check if it has a Raydium pool
            const poolCache = persistentPoolCache_1.PersistentPoolCache.getInstance();
            const [mint1, mint2] = [spl_token_1.NATIVE_MINT.toString(), addressStr].sort();
            const poolId = `${mint1}/${mint2}`;
            // Check pool cache
            const cachedPool = poolCache.get(poolId);
            if (cachedPool) {
                // It has a Raydium pool
                this.setTokenType(addressStr, 'migratedPump', true);
                return {
                    address: addressStr,
                    type: 'migratedPump',
                    timestamp: Date.now(),
                    hasRaydiumPool: true
                };
            }
            // Try to discover pool
            try {
                const tokenPublicKey = new web3_js_1.PublicKey(addressStr);
                const poolAccounts = await (0, poolDiscovery_1.discoverPool)(connection, spl_token_1.NATIVE_MINT, tokenPublicKey, true);
                if (poolAccounts) {
                    // Found a Raydium pool - store it
                    poolCache.set(poolId, poolAccounts);
                    this.setTokenType(addressStr, 'migratedPump', true);
                    return {
                        address: addressStr,
                        type: 'migratedPump',
                        timestamp: Date.now(),
                        hasRaydiumPool: true
                    };
                }
            }
            catch {
                // No Raydium pool found, that's okay
            }
            // It's a pure pump token
            this.setTokenType(addressStr, 'pump');
            return {
                address: addressStr,
                type: 'pump',
                timestamp: Date.now(),
                hasRaydiumPool: false
            };
        }
        catch (error) {
            // If there's an error, default to regular token
            console.error(chalk_1.default.hex(config_1.COLORS.ERROR)(`Error checking token type for ${addressStr}:`), error);
            this.setTokenType(addressStr, 'regular');
            return {
                address: addressStr,
                type: 'regular',
                timestamp: Date.now()
            };
        }
    }
}
exports.TokenTypeCache = TokenTypeCache;
