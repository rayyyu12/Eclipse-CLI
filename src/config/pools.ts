// config/pools.ts
import { PublicKey } from '@solana/web3.js';

export const TOKENS = {
    SOL: {
        mint: new PublicKey("So11111111111111111111111111111111111111112"),
        decimals: 9
    },
    // Remove hardcoded USDC, make it dynamic
};

export interface TokenInfo {
    mint: PublicKey;
    decimals: number;
}
