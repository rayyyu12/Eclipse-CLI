"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.WalletStorage = void 0;
//walletStorage.ts
const secureStorage_1 = require("./secureStorage");
const chalk_1 = __importDefault(require("chalk"));
const config_1 = require("../config");
class WalletStorage {
    constructor() {
        this.STORAGE_KEY = 'monitoredWallets';
        this.secureStorage = secureStorage_1.SecureStorage.getInstance();
    }
    static getInstance() {
        if (!WalletStorage.instance) {
            WalletStorage.instance = new WalletStorage();
        }
        return WalletStorage.instance;
    }
    getWallets() {
        try {
            const credentials = this.secureStorage.getCredentials();
            const walletsString = credentials[this.STORAGE_KEY];
            if (!walletsString) {
                return new Set();
            }
            const parsedWallets = JSON.parse(walletsString);
            if (!Array.isArray(parsedWallets)) {
                throw new Error('Invalid stored wallet format');
            }
            return new Set(parsedWallets);
        }
        catch (error) {
            console.error(chalk_1.default.hex(config_1.COLORS.ERROR)('Failed to retrieve wallets:'), error);
            return new Set();
        }
    }
    saveWallets(wallets) {
        try {
            const walletsArray = Array.from(wallets);
            const walletsString = JSON.stringify(walletsArray);
            this.secureStorage.updateCredential(this.STORAGE_KEY, walletsString);
        }
        catch (error) {
            console.error(chalk_1.default.hex(config_1.COLORS.ERROR)('Failed to save wallets:'), error);
            throw error;
        }
    }
    addWallet(wallet) {
        try {
            const wallets = this.getWallets();
            if (wallets.has(wallet)) {
                console.log(chalk_1.default.hex(config_1.COLORS.PRIMARY)('Wallet already monitored:', wallet));
                return;
            }
            wallets.add(wallet);
            this.saveWallets(wallets);
            console.log(chalk_1.default.hex(config_1.COLORS.SUCCESS)('Wallet added successfully:', wallet));
        }
        catch (error) {
            console.error(chalk_1.default.hex(config_1.COLORS.ERROR)('Failed to add wallet:'), error);
            throw error;
        }
    }
    removeWallet(wallet) {
        try {
            const wallets = this.getWallets();
            if (!wallets.has(wallet)) {
                console.log(chalk_1.default.hex(config_1.COLORS.PRIMARY)('Wallet not found:', wallet));
                return;
            }
            wallets.delete(wallet);
            this.saveWallets(wallets);
            console.log(chalk_1.default.hex(config_1.COLORS.SUCCESS)('Wallet removed successfully:', wallet));
        }
        catch (error) {
            console.error(chalk_1.default.hex(config_1.COLORS.ERROR)('Failed to remove wallet:'), error);
            throw error;
        }
    }
    clearWallets() {
        try {
            this.secureStorage.updateCredential(this.STORAGE_KEY, undefined);
            console.log(chalk_1.default.hex(config_1.COLORS.SUCCESS)('All wallets cleared successfully'));
        }
        catch (error) {
            console.error(chalk_1.default.hex(config_1.COLORS.ERROR)('Failed to clear wallets:'), error);
            throw error;
        }
    }
}
exports.WalletStorage = WalletStorage;
