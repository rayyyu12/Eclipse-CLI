// src/utils/pools/tokenTypeCache.ts
import fs from 'fs';
import path from 'path';
import { Connection, PublicKey } from '@solana/web3.js';
import { isPumpFunToken } from '../swaps/pumpSwap';
import { PersistentPoolCache } from './persistentPoolCache';
import { NATIVE_MINT } from '@solana/spl-token';
import { discoverPool } from './poolDiscovery';
import chalk from 'chalk';
import { COLORS } from '../../cli/config';

export type TokenType = 'regular' | 'pump' | 'migratedPump';

export interface TokenTypeInfo {
    address: string;
    type: TokenType;
    timestamp: number;
    hasRaydiumPool?: boolean;
}

/**
 * Enhanced TokenTypeCache with asynchronous checking and reduced network requests.
 */
export class TokenTypeCache {
    private static instance: TokenTypeCache;
    private cache: Map<string, TokenTypeInfo>;
    private readonly filePath: string;
    private maxAge: number = 24 * 60 * 60 * 1000; // 24 hours
    private pendingChecks: Map<string, Promise<TokenTypeInfo>> = new Map();

    private constructor() {
        this.filePath = path.join(process.cwd(), 'token-types-cache.json');
        this.cache = new Map();
        this.loadFromDisk();
    }

    public static getInstance(): TokenTypeCache {
        if (!TokenTypeCache.instance) {
            TokenTypeCache.instance = new TokenTypeCache();
        }
        return TokenTypeCache.instance;
    }

    private loadFromDisk(): void {
        try {
            if (fs.existsSync(this.filePath)) {
                const data = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
                this.cache = new Map(Object.entries(data).map(([key, value]) => [key, value as TokenTypeInfo]));
                
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
        } catch (error) {
            console.log('No existing token type cache found or invalid format');
            this.cache = new Map();
        }
    }

    private saveToDisk(): void {
        try {
            const data = Object.fromEntries(this.cache);
            fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2));
        } catch (error) {
            console.error('Error saving token type cache:', error);
        }
    }

    /**
     * Set token type information in the cache
     */
    public setTokenType(address: string, type: TokenType, hasRaydiumPool: boolean = false): void {
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
    public getTokenType(address: string): TokenTypeInfo | undefined {
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
    public async checkTokenType(
        connection: Connection, 
        tokenAddress: string | PublicKey
    ): Promise<TokenTypeInfo> {
        const addressStr = tokenAddress instanceof PublicKey ? 
            tokenAddress.toString() : 
            tokenAddress;
        
        // Check if we already have a pending check for this token
        if (this.pendingChecks.has(addressStr)) {
            return this.pendingChecks.get(addressStr)!;
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
        } finally {
            // Clean up pending check
            this.pendingChecks.delete(addressStr);
        }
    }
    
    /**
     * Perform the actual token type checking logic
     */
    private async performTokenTypeCheck(
        connection: Connection,
        addressStr: string
    ): Promise<TokenTypeInfo> {
        try {
            // Skip the expensive check for non-pump tokens (quick optimization)
            if (!addressStr.endsWith('pump')) {
                const result: TokenTypeInfo = {
                    address: addressStr,
                    type: 'regular',
                    timestamp: Date.now()
                };
                this.setTokenType(addressStr, 'regular');
                return result;
            }
            
            // Check if it's a pump token
            const tokenInfo = await isPumpFunToken(connection, addressStr);
            
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
            const poolCache = PersistentPoolCache.getInstance();
            const [mint1, mint2] = [NATIVE_MINT.toString(), addressStr].sort();
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
                const tokenPublicKey = new PublicKey(addressStr);
                const poolAccounts = await discoverPool(connection, NATIVE_MINT, tokenPublicKey, true);
                
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
            } catch {
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
            
        } catch (error) {
            // If there's an error, default to regular token
            console.error(chalk.hex(COLORS.ERROR)(`Error checking token type for ${addressStr}:`), error);
            this.setTokenType(addressStr, 'regular');
            return {
                address: addressStr,
                type: 'regular',
                timestamp: Date.now()
            };
        }
    }
}