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
Object.defineProperty(exports, "__esModule", { value: true });
exports.tokenTracker = exports.TokenTracker = void 0;
//tokenTracker.ts
const web3_js_1 = require("@solana/web3.js");
const spl_token_1 = require("@solana/spl-token");
const fs = __importStar(require("fs/promises"));
const path = __importStar(require("path"));
class TokenTracker {
    constructor() {
        this.dbPath = path.join(process.cwd(), 'token-positions.json');
        this.positions = {};
    }
    async loadPositions() {
        try {
            const data = await fs.readFile(this.dbPath, 'utf-8');
            this.positions = JSON.parse(data);
        }
        catch {
            this.positions = {};
            await this.savePositions();
        }
    }
    async savePositions() {
        await fs.writeFile(this.dbPath, JSON.stringify(this.positions, null, 2));
    }
    calculateAverageEntry(transactions) {
        const buyTxs = transactions.filter(tx => tx.type === 'buy');
        if (buyTxs.length === 0)
            return 0;
        const totalSol = buyTxs.reduce((sum, tx) => sum + tx.solAmount, 0);
        const totalTokens = buyTxs.reduce((sum, tx) => sum + tx.tokenAmount, 0);
        return totalSol / totalTokens;
    }
    async recordTransaction(tokenAddress, type, solAmount, tokenAmount, signature) {
        await this.loadPositions();
        const pricePerToken = solAmount / tokenAmount;
        const transaction = {
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
        }
        else {
            position.currentTokens -= tokenAmount;
            position.totalInvestment *= (position.currentTokens / (position.currentTokens + tokenAmount));
        }
        position.averageEntryPrice = this.calculateAverageEntry(position.transactions);
        await this.savePositions();
        return this.calculateProfitMetrics(tokenAddress, type, solAmount, tokenAmount);
    }
    calculateProfitMetrics(tokenAddress, type, solAmount, tokenAmount) {
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
    async getCurrentValue(connection, tokenAddress) {
        const position = this.positions[tokenAddress];
        if (!position || position.currentTokens === 0)
            return null;
        try {
            const tokenAccount = await (0, spl_token_1.getAccount)(connection, new web3_js_1.PublicKey(tokenAddress));
            return position.currentTokens * (position.totalInvestment / Number(tokenAccount.amount));
        }
        catch {
            return null;
        }
    }
}
exports.TokenTracker = TokenTracker;
exports.tokenTracker = new TokenTracker();
