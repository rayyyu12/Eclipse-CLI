// src/cli/utils/copyTradeSettings.ts

import * as fs from 'fs';
import * as path from 'path';
import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import chalk from 'chalk';
import { COLORS } from '../config';

export enum BuyMode {
    FIXED = "FIXED",
    MIRROR = "MIRROR"
}

export interface CopyTradeSettings {
    // Buy settings
    buyMode: BuyMode;
    fixedBuyAmount: number;      // In SOL
    // Remove mirrorPercentage field
    
    // Filters
    minBuyAmount: number;        // Minimum buy amount to copy (in SOL)
    maxBuyAmount: number;        // Maximum buy amount to copy (in SOL)
    enabled: {
        pump: boolean;           // Enable/disable pump.fun copying
        raydium: boolean;        // Enable/disable raydium copying
    };
    
    // Slippage settings
    slippageTolerance: {
        pump: number;            // Pump.fun slippage tolerance (0-100)
        raydium: number;         // Raydium slippage tolerance (0-100)
    }
}

const DEFAULT_SETTINGS: CopyTradeSettings = {
    buyMode: BuyMode.FIXED,
    fixedBuyAmount: 0.0001,      // 0.0001 SOL default
    minBuyAmount: 0,             // No minimum by default
    maxBuyAmount: 100,           // 100 SOL max by default
    enabled: {
        pump: true,              // Both protocols enabled by default
        raydium: true
    },
    slippageTolerance: {
        pump: 10,                // 10% default for pump
        raydium: 50              // 50% default for raydium
    }
};

export class CopyTradeSettingsManager {
    private static instance: CopyTradeSettingsManager;
    private settings: CopyTradeSettings;
    private readonly settingsPath: string;

    private constructor() {
        // Ensure config directory exists
        const configDir = path.join(__dirname, '../../config');
        if (!fs.existsSync(configDir)) {
            fs.mkdirSync(configDir, { recursive: true });
        }

        this.settingsPath = path.join(configDir, 'copyTradeSettings.json');
        this.settings = this.loadSettings();
    }

    public static getInstance(): CopyTradeSettingsManager {
        if (!CopyTradeSettingsManager.instance) {
            CopyTradeSettingsManager.instance = new CopyTradeSettingsManager();
        }
        return CopyTradeSettingsManager.instance;
    }

    private loadSettings(): CopyTradeSettings {
        try {
            if (fs.existsSync(this.settingsPath)) {
                const data = fs.readFileSync(this.settingsPath, 'utf8');
                const loadedSettings = JSON.parse(data);
                // Merge with defaults to ensure all fields exist
                return { ...DEFAULT_SETTINGS, ...loadedSettings };
            }
        } catch (error) {
            console.error(chalk.hex(COLORS.ERROR)('Error loading settings:'), error);
        }
        
        // Save default settings if none exist
        this.saveSettings(DEFAULT_SETTINGS);
        return { ...DEFAULT_SETTINGS };
    }

    public saveSettings(newSettings?: Partial<CopyTradeSettings>): void {
        try {
            if (newSettings) {
                this.settings = { ...this.settings, ...newSettings };
            }
            fs.writeFileSync(this.settingsPath, JSON.stringify(this.settings, null, 2));
            console.log(chalk.hex(COLORS.SUCCESS)('Settings saved successfully'));
        } catch (error) {
            console.error(chalk.hex(COLORS.ERROR)('Error saving settings:'), error);
            throw error;
        }
    }

    public getSettings(): CopyTradeSettings {
        return { ...this.settings };
    }

    public updateSettings(newSettings: Partial<CopyTradeSettings>): void {
        // Validate new settings before saving
        this.validateSettings(newSettings);
        this.settings = {
            ...this.settings,
            ...newSettings
        };
        this.saveSettings();
    }

    private validateSettings(settings: Partial<CopyTradeSettings>): void {
        if (settings.fixedBuyAmount !== undefined && settings.fixedBuyAmount <= 0) {
            throw new Error('Fixed buy amount must be greater than 0');
        }
        if (settings.minBuyAmount !== undefined && settings.minBuyAmount < 0) {
            throw new Error('Minimum buy amount cannot be negative');
        }
        if (settings.maxBuyAmount !== undefined && settings.maxBuyAmount <= 0) {
            throw new Error('Maximum buy amount must be greater than 0');
        }
        if (settings.minBuyAmount !== undefined && 
            settings.maxBuyAmount !== undefined && 
            settings.minBuyAmount >= settings.maxBuyAmount) {
            throw new Error('Minimum buy amount must be less than maximum buy amount');
        }
        if (settings.slippageTolerance?.pump !== undefined && 
            (settings.slippageTolerance.pump <= 0 || settings.slippageTolerance.pump > 100)) {
            throw new Error('Pump slippage tolerance must be between 0 and 100');
        }
        if (settings.slippageTolerance?.raydium !== undefined && 
            (settings.slippageTolerance.raydium <= 0 || settings.slippageTolerance.raydium > 100)) {
            throw new Error('Raydium slippage tolerance must be between 0 and 100');
        }
    }

    public calculateBuyAmount(detectedAmount: number): number {
        switch (this.settings.buyMode) {
            case BuyMode.FIXED:
                return this.settings.fixedBuyAmount * LAMPORTS_PER_SOL;
            
            case BuyMode.MIRROR:
                return detectedAmount;
            
            default:
                return this.settings.fixedBuyAmount * LAMPORTS_PER_SOL;
        }
    }

    public shouldCopyTrade(detectedAmount: number): boolean {
        const amountInSol = detectedAmount / LAMPORTS_PER_SOL;
        
        // Check minimum amount
        if (this.settings.minBuyAmount > 0 && amountInSol < this.settings.minBuyAmount) {
            console.log(chalk.yellow(`Trade amount (${amountInSol} SOL) below minimum (${this.settings.minBuyAmount} SOL)`));
            return false;
        }

        // Check maximum amount
        if (this.settings.maxBuyAmount > 0 && amountInSol > this.settings.maxBuyAmount) {
            console.log(chalk.yellow(`Trade amount (${amountInSol} SOL) above maximum (${this.settings.maxBuyAmount} SOL)`));
            return false;
        }

        return true;
    }

    public getSlippageTolerance(protocol: 'pump' | 'raydium'): number {
        return this.settings.slippageTolerance[protocol] / 100; // Convert percentage to decimal
    }
}