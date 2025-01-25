// tokenTypeCache.ts
import fs from 'fs';
import path from 'path';

interface TokenTypeInfo {
    address: string;
    type: 'regular' | 'migratedPump';
}

export class TokenTypeCache {
    private static instance: TokenTypeCache;
    private cache: Map<string, TokenTypeInfo>;
    private readonly filePath: string;

    private constructor() {
        this.filePath = path.join(process.cwd(), 'token-types-cache.json');
        this.cache = new Map();
        this.loadFromDisk();
    }

    static getInstance(): TokenTypeCache {
        if (!TokenTypeCache.instance) {
            TokenTypeCache.instance = new TokenTypeCache();
        }
        return TokenTypeCache.instance;
    }

    private loadFromDisk(): void {
        try {
            if (fs.existsSync(this.filePath)) {
                const data = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
                this.cache = new Map(Object.entries(data));
            }
        } catch (error) {
            console.log('No existing token type cache found');
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

    setTokenType(address: string, type: 'regular' | 'migratedPump'): void {
        this.cache.set(address, {
            address,
            type
        });
        this.saveToDisk();
    }

    getTokenType(address: string): TokenTypeInfo | undefined {
        return this.cache.get(address);
    }
}