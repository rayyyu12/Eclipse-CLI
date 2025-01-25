//persistentPoolCache.ts
import { PoolAccounts } from "../../types";
import { PublicKey } from '@solana/web3.js';
import fs from 'fs';
import path from 'path';

interface SerializedPoolAccounts {
  id: string;
  ammId: string;
  ammAuthority: string;
  ammOpenOrders: string;
  ammTargetOrders: string;
  poolCoinTokenAccount: string;
  poolPcTokenAccount: string;
  serumProgramId: string;
  serumMarket: string;
  serumBids: string;
  serumAsks: string;
  serumEventQueue: string;
  serumCoinVaultAccount: string;
  serumPcVaultAccount: string;
  serumVaultSigner: string;
}

export class PersistentPoolCache {
  private static instance: PersistentPoolCache;
  private cache: Map<string, SerializedPoolAccounts>;
  private readonly filePath: string;

  private constructor() {
    this.filePath = path.join(process.cwd(), 'pools-cache.json');
    this.cache = new Map();
    this.loadFromDisk();
  }

  static getInstance(): PersistentPoolCache {
    if (!PersistentPoolCache.instance) {
      PersistentPoolCache.instance = new PersistentPoolCache();
    }
    return PersistentPoolCache.instance;
  }

  private loadFromDisk(): void {
    try {
      if (fs.existsSync(this.filePath)) {
        const data = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
        this.cache = new Map(Object.entries(data));
      }
    } catch (error) {
    }
  }

  private saveToDisk(): void {
    try {
      const data = Object.fromEntries(this.cache);
      fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2));
    } catch (error) {
    }
  }

  set(poolId: string, accounts: PoolAccounts): void {
    const serializedAccounts: SerializedPoolAccounts = {
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

  get(poolId: string): PoolAccounts | undefined {
    const serialized = this.cache.get(poolId);
    if (!serialized) {
      return undefined;
    }

    return {
      id: serialized.id,
      ammId: new PublicKey(serialized.ammId),
      ammAuthority: new PublicKey(serialized.ammAuthority),
      ammOpenOrders: new PublicKey(serialized.ammOpenOrders),
      ammTargetOrders: new PublicKey(serialized.ammTargetOrders),
      poolCoinTokenAccount: new PublicKey(serialized.poolCoinTokenAccount),
      poolPcTokenAccount: new PublicKey(serialized.poolPcTokenAccount),
      serumProgramId: new PublicKey(serialized.serumProgramId),
      serumMarket: new PublicKey(serialized.serumMarket),
      serumBids: new PublicKey(serialized.serumBids),
      serumAsks: new PublicKey(serialized.serumAsks),
      serumEventQueue: new PublicKey(serialized.serumEventQueue),
      serumCoinVaultAccount: new PublicKey(serialized.serumCoinVaultAccount),
      serumPcVaultAccount: new PublicKey(serialized.serumPcVaultAccount),
      serumVaultSigner: new PublicKey(serialized.serumVaultSigner)
    };
  }
}
