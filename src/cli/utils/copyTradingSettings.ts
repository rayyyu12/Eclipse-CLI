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
    buyMode: BuyMode;
    fixedBuyAmount: number;      // In SOL
    minBuyAmount: number;        // Minimum buy amount to copy (in SOL)
    maxBuyAmount: number;        // Maximum buy amount to copy (in SOL)
    enabled: {
        pump: boolean;           // Enable/disable pump.fun copying
        raydium: boolean;        // Enable/disable raydium copying
    };
    slippageTolerance: {
        pump: number;            // Pump.fun slippage tolerance (0-100)
        raydium: number;         // Raydium slippage tolerance (0-100)
    }
}

const DEFAULT_SETTINGS: CopyTradeSettings = {
    buyMode: BuyMode.FIXED,
    fixedBuyAmount: 0.0001,
    minBuyAmount: 0,
    maxBuyAmount: 100,
    enabled: {
        pump: true,
        raydium: true
    },
    slippageTolerance: {
        pump: 10,
        raydium: 50
    }
};

export class CopyTradeSettingsManager {
    private static instance: CopyTradeSettingsManager;
    private settings: CopyTradeSettings;
    private readonly settingsPath: string;

    private constructor() {
        const configDir = path.join(__dirname, '../../config');
        if (!fs.existsSync(configDir)) {
            fs.mkdirSync(configDir, { recursive: true });
            console.log(chalk.hex(COLORS.PRIMARY)('Created config directory'));
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
                const mergedSettings = { ...DEFAULT_SETTINGS, ...loadedSettings };
                
                console.log(chalk.hex(COLORS.SUCCESS)('Settings loaded successfully'));
                return mergedSettings;
            }
        } catch (error) {
            console.error(chalk.hex(COLORS.ERROR)('Failed to load settings:'), error);
        }
        
        this.saveSettings(DEFAULT_SETTINGS);
        console.log(chalk.hex(COLORS.PRIMARY)('Using default settings'));
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
            console.error(chalk.hex(COLORS.ERROR)('Failed to save settings:'), error);
            throw error;
        }
    }

    public getSettings(): CopyTradeSettings {
        return { ...this.settings };
    }

    public updateSettings(newSettings: Partial<CopyTradeSettings>): void {
        try {
            this.validateSettings(newSettings);
            this.settings = { ...this.settings, ...newSettings };
            this.saveSettings();
            console.log(chalk.hex(COLORS.SUCCESS)('Settings updated successfully'));
        } catch (error) {
            console.error(chalk.hex(COLORS.ERROR)('Failed to update settings:'), error);
            throw error;
        }
    }

    private validateSettings(settings: Partial<CopyTradeSettings>): void {
        const errors: string[] = [];

        if (settings.fixedBuyAmount !== undefined && settings.fixedBuyAmount <= 0) {
            errors.push('Fixed buy amount must be greater than 0');
        }

        if (settings.minBuyAmount !== undefined && settings.minBuyAmount < 0) {
            errors.push('Minimum buy amount cannot be negative');
        }

        if (settings.maxBuyAmount !== undefined && settings.maxBuyAmount <= 0) {
            errors.push('Maximum buy amount must be greater than 0');
        }

        if (settings.minBuyAmount !== undefined && 
            settings.maxBuyAmount !== undefined && 
            settings.minBuyAmount >= settings.maxBuyAmount) {
            errors.push('Minimum buy amount must be less than maximum buy amount');
        }

        if (settings.slippageTolerance?.pump !== undefined && 
            (settings.slippageTolerance.pump <= 0 || settings.slippageTolerance.pump > 100)) {
            errors.push('Pump slippage tolerance must be between 0 and 100');
        }

        if (settings.slippageTolerance?.raydium !== undefined && 
            (settings.slippageTolerance.raydium <= 0 || settings.slippageTolerance.raydium > 100)) {
            errors.push('Raydium slippage tolerance must be between 0 and 100');
        }

        if (errors.length > 0) {
            throw new Error(errors.join('; '));
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
        
        if (this.settings.minBuyAmount > 0 && amountInSol < this.settings.minBuyAmount) {
            console.log(chalk.hex(COLORS.ERROR)(
                `Trade skipped: Amount ${amountInSol.toFixed(4)} SOL below minimum ${this.settings.minBuyAmount} SOL`
            ));
            return false;
        }

        if (this.settings.maxBuyAmount > 0 && amountInSol > this.settings.maxBuyAmount) {
            console.log(chalk.hex(COLORS.ERROR)(
                `Trade skipped: Amount ${amountInSol.toFixed(4)} SOL above maximum ${this.settings.maxBuyAmount} SOL`
            ));
            return false;
        }

        return true;
    }

    public getSlippageTolerance(protocol: 'pump' | 'raydium'): number {
        return this.settings.slippageTolerance[protocol] / 100;
    }
}