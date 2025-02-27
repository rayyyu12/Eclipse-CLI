"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PersistentPoolCache = void 0;
const web3_js_1 = require("@solana/web3.js");
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
class PersistentPoolCache {
    constructor() {
        this.filePath = path_1.default.join(process.cwd(), 'pools-cache.json');
        this.cache = new Map();
        this.loadFromDisk();
    }
    static getInstance() {
        if (!PersistentPoolCache.instance) {
            PersistentPoolCache.instance = new PersistentPoolCache();
        }
        return PersistentPoolCache.instance;
    }
    loadFromDisk() {
        try {
            if (fs_1.default.existsSync(this.filePath)) {
                const data = JSON.parse(fs_1.default.readFileSync(this.filePath, 'utf8'));
                this.cache = new Map(Object.entries(data));
            }
        }
        catch (error) {
        }
    }
    saveToDisk() {
        try {
            const data = Object.fromEntries(this.cache);
            fs_1.default.writeFileSync(this.filePath, JSON.stringify(data, null, 2));
        }
        catch (error) {
        }
    }
    set(poolId, accounts) {
        const serializedAccounts = {
            id: accounts.id,
            ammId: accounts.ammId.toBase58(),
            ammAuthority: accounts.ammAuthority.toBase58(),
            ammOpenOrders: accounts.ammOpenOrders.toBase58(),
            ammTargetOrders: accounts.ammTargetOrders.toBase58(),
            poolCoinTokenAccount: accounts.poolCoinTokenAccount.toBase58(),
            poolPcTokenAccount: accounts.poolPcTokenAccount.toBase58(),
            serumProgramId: accounts.serumProgramId.toBase58(),
            serumMarket: accounts.serumMarket.toBase58(),
            serumBids: accounts.serumBids.toBase58(),
            serumAsks: accounts.serumAsks.toBase58(),
            serumEventQueue: accounts.serumEventQueue.toBase58(),
            serumCoinVaultAccount: accounts.serumCoinVaultAccount.toBase58(),
            serumPcVaultAccount: accounts.serumPcVaultAccount.toBase58(),
            serumVaultSigner: accounts.serumVaultSigner.toBase58()
        };
        this.cache.set(poolId, serializedAccounts);
        this.saveToDisk();
    }
    get(poolId) {
        const serialized = this.cache.get(poolId);
        if (!serialized) {
            return undefined;
        }
        return {
            id: serialized.id,
            ammId: new web3_js_1.PublicKey(serialized.ammId),
            ammAuthority: new web3_js_1.PublicKey(serialized.ammAuthority),
            ammOpenOrders: new web3_js_1.PublicKey(serialized.ammOpenOrders),
            ammTargetOrders: new web3_js_1.PublicKey(serialized.ammTargetOrders),
            poolCoinTokenAccount: new web3_js_1.PublicKey(serialized.poolCoinTokenAccount),
            poolPcTokenAccount: new web3_js_1.PublicKey(serialized.poolPcTokenAccount),
            serumProgramId: new web3_js_1.PublicKey(serialized.serumProgramId),
            serumMarket: new web3_js_1.PublicKey(serialized.serumMarket),
            serumBids: new web3_js_1.PublicKey(serialized.serumBids),
            serumAsks: new web3_js_1.PublicKey(serialized.serumAsks),
            serumEventQueue: new web3_js_1.PublicKey(serialized.serumEventQueue),
            serumCoinVaultAccount: new web3_js_1.PublicKey(serialized.serumCoinVaultAccount),
            serumPcVaultAccount: new web3_js_1.PublicKey(serialized.serumPcVaultAccount),
            serumVaultSigner: new web3_js_1.PublicKey(serialized.serumVaultSigner)
        };
    }
}
exports.PersistentPoolCache = PersistentPoolCache;
