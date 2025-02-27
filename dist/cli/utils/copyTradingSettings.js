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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CopyTradeSettingsManager = exports.BuyMode = void 0;
//copyTradingSettings.ts
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const web3_js_1 = require("@solana/web3.js");
const chalk_1 = __importDefault(require("chalk"));
const config_1 = require("../config");
var BuyMode;
(function (BuyMode) {
    BuyMode["FIXED"] = "FIXED";
    BuyMode["MIRROR"] = "MIRROR";
})(BuyMode || (exports.BuyMode = BuyMode = {}));
const DEFAULT_SETTINGS = {
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
class CopyTradeSettingsManager {
    constructor() {
        const configDir = path.join(__dirname, '../../config');
        if (!fs.existsSync(configDir)) {
            fs.mkdirSync(configDir, { recursive: true });
            console.log(chalk_1.default.hex(config_1.COLORS.PRIMARY)('Created config directory'));
        }
        this.settingsPath = path.join(configDir, 'copyTradeSettings.json');
        this.settings = this.loadSettings();
    }
    static getInstance() {
        if (!CopyTradeSettingsManager.instance) {
            CopyTradeSettingsManager.instance = new CopyTradeSettingsManager();
        }
        return CopyTradeSettingsManager.instance;
    }
    loadSettings() {
        try {
            if (fs.existsSync(this.settingsPath)) {
                const data = fs.readFileSync(this.settingsPath, 'utf8');
                const loadedSettings = JSON.parse(data);
                const mergedSettings = { ...DEFAULT_SETTINGS, ...loadedSettings };
                console.log(chalk_1.default.hex(config_1.COLORS.SUCCESS)('Settings loaded successfully'));
                return mergedSettings;
            }
        }
        catch (error) {
            console.error(chalk_1.default.hex(config_1.COLORS.ERROR)('Failed to load settings:'), error);
        }
        this.saveSettings(DEFAULT_SETTINGS);
        console.log(chalk_1.default.hex(config_1.COLORS.PRIMARY)('Using default settings'));
        return { ...DEFAULT_SETTINGS };
    }
    saveSettings(newSettings) {
        try {
            if (newSettings) {
                this.settings = { ...this.settings, ...newSettings };
            }
            fs.writeFileSync(this.settingsPath, JSON.stringify(this.settings, null, 2));
            console.log(chalk_1.default.hex(config_1.COLORS.SUCCESS)('Settings saved successfully'));
        }
        catch (error) {
            console.error(chalk_1.default.hex(config_1.COLORS.ERROR)('Failed to save settings:'), error);
            throw error;
        }
    }
    getSettings() {
        return { ...this.settings };
    }
    updateSettings(newSettings) {
        try {
            this.validateSettings(newSettings);
            this.settings = { ...this.settings, ...newSettings };
            this.saveSettings();
            console.log(chalk_1.default.hex(config_1.COLORS.SUCCESS)('Settings updated successfully'));
        }
        catch (error) {
            console.error(chalk_1.default.hex(config_1.COLORS.ERROR)('Failed to update settings:'), error);
            throw error;
        }
    }
    validateSettings(settings) {
        const errors = [];
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
    calculateBuyAmount(detectedAmount) {
        switch (this.settings.buyMode) {
            case BuyMode.FIXED:
                return this.settings.fixedBuyAmount * web3_js_1.LAMPORTS_PER_SOL;
            case BuyMode.MIRROR:
                return detectedAmount;
            default:
                return this.settings.fixedBuyAmount * web3_js_1.LAMPORTS_PER_SOL;
        }
    }
    shouldCopyTrade(detectedAmount) {
        const amountInSol = detectedAmount / web3_js_1.LAMPORTS_PER_SOL;
        if (this.settings.minBuyAmount > 0 && amountInSol < this.settings.minBuyAmount) {
            console.log(chalk_1.default.hex(config_1.COLORS.ERROR)(`Trade skipped: Amount ${amountInSol.toFixed(4)} SOL below minimum ${this.settings.minBuyAmount} SOL`));
            return false;
        }
        if (this.settings.maxBuyAmount > 0 && amountInSol > this.settings.maxBuyAmount) {
            console.log(chalk_1.default.hex(config_1.COLORS.ERROR)(`Trade skipped: Amount ${amountInSol.toFixed(4)} SOL above maximum ${this.settings.maxBuyAmount} SOL`));
            return false;
        }
        return true;
    }
    getSlippageTolerance(protocol) {
        return this.settings.slippageTolerance[protocol] / 100;
    }
}
exports.CopyTradeSettingsManager = CopyTradeSettingsManager;
