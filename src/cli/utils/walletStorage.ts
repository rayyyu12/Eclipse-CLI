import { SecureStorage } from './secureStorage';
import chalk from 'chalk';
import { COLORS } from '../config';

export class WalletStorage {
    private static instance: WalletStorage;
    private secureStorage: SecureStorage;
    private readonly STORAGE_KEY = 'monitoredWallets' as const;

    private constructor() {
        this.secureStorage = SecureStorage.getInstance();
    }

    public static getInstance(): WalletStorage {
        if (!WalletStorage.instance) {
            WalletStorage.instance = new WalletStorage();
        }
        return WalletStorage.instance;
    }

    public getWallets(): Set<string> {
        try {
            const credentials = this.secureStorage.getCredentials();
            const walletsString = credentials[this.STORAGE_KEY];
            
            if (!walletsString) {
                return new Set<string>();
            }

            const parsedWallets = JSON.parse(walletsString);
            if (!Array.isArray(parsedWallets)) {
                throw new Error('Invalid stored wallet format');
            }

            return new Set<string>(parsedWallets);
        } catch (error) {
            console.error(chalk.hex(COLORS.ERROR)('Failed to retrieve wallets:'), error);
            return new Set<string>();
        }
    }

    public saveWallets(wallets: Set<string>): void {
        try {
            const walletsArray = Array.from(wallets);
            const walletsString = JSON.stringify(walletsArray);
            this.secureStorage.updateCredential(this.STORAGE_KEY, walletsString);
        } catch (error) {
            console.error(chalk.hex(COLORS.ERROR)('Failed to save wallets:'), error);
            throw error;
        }
    }

    public addWallet(wallet: string): void {
        try {
            const wallets = this.getWallets();
            if (wallets.has(wallet)) {
                console.log(chalk.hex(COLORS.PRIMARY)('Wallet already monitored:', wallet));
                return;
            }
            
            wallets.add(wallet);
            this.saveWallets(wallets);
            console.log(chalk.hex(COLORS.SUCCESS)('Wallet added successfully:', wallet));
        } catch (error) {
            console.error(chalk.hex(COLORS.ERROR)('Failed to add wallet:'), error);
            throw error;
        }
    }

    public removeWallet(wallet: string): void {
        try {
            const wallets = this.getWallets();
            if (!wallets.has(wallet)) {
                console.log(chalk.hex(COLORS.PRIMARY)('Wallet not found:', wallet));
                return;
            }
            
            wallets.delete(wallet);
            this.saveWallets(wallets);
            console.log(chalk.hex(COLORS.SUCCESS)('Wallet removed successfully:', wallet));
        } catch (error) {
            console.error(chalk.hex(COLORS.ERROR)('Failed to remove wallet:'), error);
            throw error;
        }
    }

    public clearWallets(): void {
        try {
            this.secureStorage.updateCredential(this.STORAGE_KEY, undefined);
            console.log(chalk.hex(COLORS.SUCCESS)('All wallets cleared successfully'));
        } catch (error) {
            console.error(chalk.hex(COLORS.ERROR)('Failed to clear wallets:'), error);
            throw error;
        }
    }
}