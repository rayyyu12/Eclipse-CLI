// src/cli/utils/copyTradeSettings.ts

import { LAMPORTS_PER_SOL } from "@solana/web3.js";

export enum BuyMode {
    FIXED = "FIXED",
    MIRROR = "MIRROR",
    PERCENTAGE = "PERCENTAGE"
}

export interface CopyTradeSettings {
    // Buy settings
    buyMode: BuyMode;
    fixedBuyAmount: number;      // In SOL
    mirrorPercentage: number;    // For percentage mode (0-100)
    
    // Filters
    minBuyAmount: number;        // Minimum buy amount to copy (in SOL)
    maxBuyAmount: number;        // Maximum buy amount to copy (in SOL)
    enabled: {
        pump: boolean;           // Enable/disable pump.fun copying
        raydium: boolean;        // Enable/disable raydium copying
    };
    
    // Additional settings can be added here
    slippageTolerance: number;   // Default slippage tolerance (0-100)
}

const DEFAULT_SETTINGS: CopyTradeSettings = {
    buyMode: BuyMode.FIXED,
    fixedBuyAmount: 0.0001,      // 0.0001 SOL default
    mirrorPercentage: 100,       // 100% by default
    minBuyAmount: 0,             // No minimum by default
    maxBuyAmount: 100,           // 100 SOL max by default
    enabled: {
        pump: true,
        raydium: true
    },
    slippageTolerance: 10        // 10% default slippage
};

export class CopyTradeSettingsManager {
    private static instance: CopyTradeSettingsManager;
    private settings: CopyTradeSettings;

    private constructor() {
        this.settings = this.loadSettings();
    }

    public static getInstance(): CopyTradeSettingsManager {
        if (!CopyTradeSettingsManager.instance) {
            CopyTradeSettingsManager.instance = new CopyTradeSettingsManager();
        }
        return CopyTradeSettingsManager.instance;
    }

    private loadSettings(): CopyTradeSettings {
        // TODO: Load from file system
        return { ...DEFAULT_SETTINGS };
    }

    public saveSettings(): void {
        // TODO: Save to file system
    }

    public getSettings(): CopyTradeSettings {
        return { ...this.settings };
    }

    public updateSettings(newSettings: Partial<CopyTradeSettings>): void {
        this.settings = {
            ...this.settings,
            ...newSettings
        };
        this.saveSettings();
    }

    public calculateBuyAmount(detectedAmount: number): number {
        switch (this.settings.buyMode) {
            case BuyMode.FIXED:
                return this.settings.fixedBuyAmount * LAMPORTS_PER_SOL;
            
            case BuyMode.MIRROR:
                return detectedAmount;
            
            case BuyMode.PERCENTAGE:
                return (detectedAmount * this.settings.mirrorPercentage) / 100;
            
            default:
                return this.settings.fixedBuyAmount * LAMPORTS_PER_SOL;
        }
    }

    public shouldCopyTrade(detectedAmount: number): boolean {
        const amountInSol = detectedAmount / LAMPORTS_PER_SOL;
        
        // Check minimum amount
        if (this.settings.minBuyAmount > 0 && amountInSol < this.settings.minBuyAmount) {
            return false;
        }

        // Check maximum amount
        if (this.settings.maxBuyAmount > 0 && amountInSol > this.settings.maxBuyAmount) {
            return false;
        }

        return true;
    }
}