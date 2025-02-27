//tokenTracker.ts
import { Connection, PublicKey } from '@solana/web3.js';
import { getAccount } from '@solana/spl-token';
import * as fs from 'fs/promises';
import * as path from 'path';

interface TokenTransaction {
    tokenAddress: string;
    timestamp: number;
    type: 'buy' | 'sell';
    solAmount: number;
    tokenAmount: number;
    pricePerToken: number;
    signature: string;
}

interface TokenPosition {
    tokenAddress: string;
    transactions: TokenTransaction[];
    currentTokens: number;
    totalInvestment: number;
    averageEntryPrice: number;
}

export class TokenTracker {
    private dbPath: string;
    private positions: { [key: string]: TokenPosition };
    
    constructor() {
        this.dbPath = path.join(process.cwd(), 'token-positions.json');
        this.positions = {};
    }

    private async loadPositions() {
        try {
            const data = await fs.readFile(this.dbPath, 'utf-8');
            this.positions = JSON.parse(data);
        } catch {
            this.positions = {};
            await this.savePositions();
        }
    }

    private async savePositions() {
        await fs.writeFile(this.dbPath, JSON.stringify(this.positions, null, 2));
    }

    private calculateAverageEntry(transactions: TokenTransaction[]): number {
        const buyTxs = transactions.filter(tx => tx.type === 'buy');
        if (buyTxs.length === 0) return 0;

        const totalSol = buyTxs.reduce((sum, tx) => sum + tx.solAmount, 0);
        const totalTokens = buyTxs.reduce((sum, tx) => sum + tx.tokenAmount, 0);
        return totalSol / totalTokens;
    }

    async recordTransaction(
        tokenAddress: string,
        type: 'buy' | 'sell',
        solAmount: number,
        tokenAmount: number,
        signature: string
    ) {
        await this.loadPositions();

        const pricePerToken = solAmount / tokenAmount;
        const transaction: TokenTransaction = {
            tokenAddress,
            timestamp: Date.now(),
            type,
            solAmount,
            tokenAmount,
            pricePerToken,
            signature
        };

        if (!this.positions[tokenAddress]) {
            this.positions[tokenAddress] = {
                tokenAddress,
                transactions: [],
                currentTokens: 0,
                totalInvestment: 0,
                averageEntryPrice: 0
            };
        }

        const position = this.positions[tokenAddress];
        position.transactions.push(transaction);

        if (type === 'buy') {
            position.currentTokens += tokenAmount;
            position.totalInvestment += solAmount;
        } else {
            position.currentTokens -= tokenAmount;
            position.totalInvestment *= (position.currentTokens / (position.currentTokens + tokenAmount));
        }

        position.averageEntryPrice = this.calculateAverageEntry(position.transactions);
        await this.savePositions();

        return this.calculateProfitMetrics(tokenAddress, type, solAmount, tokenAmount);
    }

    private calculateProfitMetrics(tokenAddress: string, type: 'buy' | 'sell', solAmount: number, tokenAmount: number) {
        const position = this.positions[tokenAddress];
        const transactions = position.transactions;
        
        if (type === 'sell' && transactions.length > 1) {
            const lastBuy = [...transactions].reverse().find(tx => tx.type === 'buy');
            const entryPrice = lastBuy ? lastBuy.pricePerToken : 0;
            const exitPrice = solAmount / tokenAmount;
            const profitPercent = ((exitPrice - entryPrice) / entryPrice) * 100;

            return {
                entryPrice,
                exitPrice,
                profitPercent,
                profitSOL: solAmount - (tokenAmount * entryPrice)
            };
        }

        return null;
    }

    async getCurrentValue(connection: Connection, tokenAddress: string): Promise<number | null> {
        const position = this.positions[tokenAddress];
        if (!position || position.currentTokens === 0) return null;

        try {
            const tokenAccount = await getAccount(
                connection,
                new PublicKey(tokenAddress)
            );
            
            return position.currentTokens * (position.totalInvestment / Number(tokenAccount.amount));
        } catch {
            return null;
        }
    }
}

export const tokenTracker = new TokenTracker();