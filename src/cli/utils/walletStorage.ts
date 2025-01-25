// src/cli/utils/walletStorage.ts
import { SecureStorage } from './secureStorage';

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
        const credentials = this.secureStorage.getCredentials();
        try {
            console.log('Debug: Raw credentials:', credentials);
            const walletsString = credentials[this.STORAGE_KEY];
            console.log('Debug: Stored wallets string:', walletsString);
            if (!walletsString) return new Set<string>();
            const parsedWallets = JSON.parse(walletsString);
            console.log('Debug: Parsed wallets:', parsedWallets);
            return new Set<string>(parsedWallets);
        } catch (error) {
            console.error('Error parsing stored wallets:', error);
            return new Set<string>();
        }
    }

    public saveWallets(wallets: Set<string>): void {
        console.log('Debug: Saving wallets:', Array.from(wallets));
        const walletsArray = Array.from(wallets);
        const walletsString = JSON.stringify(walletsArray);
        console.log('Debug: Saving wallets string:', walletsString);
        this.secureStorage.updateCredential(this.STORAGE_KEY, walletsString);
    }

    public addWallet(wallet: string): void {
        const wallets = this.getWallets();
        wallets.add(wallet);
        this.saveWallets(wallets);
    }

    public removeWallet(wallet: string): void {
        const wallets = this.getWallets();
        wallets.delete(wallet);
        this.saveWallets(wallets);
    }

    public clearWallets(): void {
        this.secureStorage.updateCredential(this.STORAGE_KEY, undefined);
    }
}