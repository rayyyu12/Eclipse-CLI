// src/cli/utils/credentialsManager.ts

import { Connection, PublicKey, Keypair } from '@solana/web3.js';
import { SecureStorage } from './secureStorage';
import bs58 from 'bs58';
import chalk from 'chalk';
import { COLORS } from '../config';

export class CredentialsManager {
    private static instance: CredentialsManager;
    private secureStorage: SecureStorage;

    private constructor() {
        this.secureStorage = SecureStorage.getInstance();
    }

    public static getInstance(): CredentialsManager {
        if (!CredentialsManager.instance) {
            CredentialsManager.instance = new CredentialsManager();
        }
        return CredentialsManager.instance;
    }

    // Validation Methods
    public async validateRpcUrl(url: string): Promise<boolean> {
        try {
            const connection = new Connection(url);
            await connection.getLatestBlockhash();
            return true;
        } catch (error) {
            console.error(chalk.hex(COLORS.ERROR)('RPC URL validation failed:'), error);
            return false;
        }
    }

    public async validateGrpcUrl(url: string): Promise<boolean> {
        try {
            new URL(url);
            return true;
        } catch (error) {
            console.error(chalk.hex(COLORS.ERROR)('GRPC URL validation failed:'), error);
            return false;
        }
    }

    public async validateAuthToken(token: string): Promise<boolean> {
        return token.length > 0;
    }

    public async validateAndConvertPrivateKey(base58Key: string): Promise<string> {
        try {
            if (!/^[1-9A-HJ-NP-Za-km-z]{87,88}$/.test(base58Key)) {
                throw new Error('Invalid base58 format');
            }

            const decoded = bs58.decode(base58Key);
            const keyArray = Array.from(decoded);
            
            try {
                Keypair.fromSecretKey(new Uint8Array(keyArray));
            } catch {
                throw new Error('Invalid private key');
            }

            return JSON.stringify(keyArray);
        } catch (error) {
            throw new Error('Invalid private key format');
        }
    }

    public async validateWsEndpoint(url: string): Promise<boolean> {
        try {
            if (!url.startsWith('ws://') && !url.startsWith('wss://')) {
                return false;
            }
            new URL(url);
            return true;
        } catch (error) {
            console.error(chalk.hex(COLORS.ERROR)('WebSocket URL validation failed:'), error);
            return false;
        }
    }

    // WebSocket Methods
    public getWsEndpoint(): string {
        const credentials = this.secureStorage.getCredentials();
        if (!credentials.wsEndpoint) {
            throw new Error('WebSocket endpoint not configured');
        }
        return credentials.wsEndpoint;
    }

    public async setWsEndpoint(url: string): Promise<void> {
        if (!await this.validateWsEndpoint(url)) {
            throw new Error('Invalid WebSocket URL format');
        }
        this.secureStorage.updateCredential('wsEndpoint', url);
        console.log(chalk.hex(COLORS.SUCCESS)('WebSocket endpoint updated successfully'));
    }

    // RPC URL Methods
    public getRpcUrl(): string {
        const credentials = this.secureStorage.getCredentials();
        if (!credentials.rpcUrl) {
            throw new Error('RPC URL not configured');
        }
        return credentials.rpcUrl;
    }

    public async setRpcUrl(url: string): Promise<void> {
        if (!await this.validateRpcUrl(url)) {
            throw new Error('Invalid RPC URL - connection failed');
        }
        this.secureStorage.updateCredential('rpcUrl', url);
        
        const stored = this.secureStorage.getCredentials().rpcUrl;
        if (stored !== url) {
            throw new Error('Failed to persist RPC URL update');
        }
        console.log(chalk.hex(COLORS.SUCCESS)('RPC URL updated successfully'));
    }

    // GRPC URL Methods
    public getGrpcUrl(): string {
        const credentials = this.secureStorage.getCredentials();
        if (!credentials.grpcUrl) {
            throw new Error('GRPC URL not configured');
        }
        return credentials.grpcUrl;
    }

    public async setGrpcUrl(url: string): Promise<void> {
        if (!await this.validateGrpcUrl(url)) {
            throw new Error('Invalid GRPC URL format');
        }
        this.secureStorage.updateCredential('grpcUrl', url);
        console.log(chalk.hex(COLORS.SUCCESS)('GRPC URL updated successfully'));
    }

    // Auth Token Methods
    public getAuthToken(): string {
        const credentials = this.secureStorage.getCredentials();
        if (!credentials.authToken) {
            throw new Error('Auth token not configured');
        }
        return credentials.authToken;
    }

    public async setAuthToken(token: string): Promise<void> {
        if (!await this.validateAuthToken(token)) {
            throw new Error('Invalid auth token format');
        }
        this.secureStorage.updateCredential('authToken', token);
        console.log(chalk.hex(COLORS.SUCCESS)('Auth token updated successfully'));
    }

    // Private Key Methods
    public getPrivateKey(): string {
        const credentials = this.secureStorage.getCredentials();
        if (!credentials.privateKey) {
            throw new Error('Private key not configured');
        }
        return credentials.privateKey;
    }

    public async setPrivateKey(base58Key: string): Promise<void> {
        const convertedKey = await this.validateAndConvertPrivateKey(base58Key);
        this.secureStorage.updateCredential('privateKey', convertedKey);
        console.log(chalk.hex(COLORS.SUCCESS)('Private key updated successfully'));
    }

    // General Credential Methods
    public hasCredentials(): boolean {
        const credentials = this.secureStorage.getCredentials();
        const hasCreds = Boolean(
            credentials.rpcUrl && 
            credentials.privateKey
        );
        return hasCreds;
    }

    public hasBasicCredentials(): boolean {
        const credentials = this.secureStorage.getCredentials();
        return Boolean(credentials.rpcUrl && credentials.privateKey);
    }

    public clearCredentials(): void {
        this.secureStorage.clearCredentials();
        console.log(chalk.hex(COLORS.SUCCESS)('All credentials cleared successfully'));
    }

    // Connection Methods
    public getConnection(): Connection {
        const wsEndpoint = this.secureStorage.getCredentials().wsEndpoint;
        return new Connection(this.getRpcUrl(), {
            commitment: 'confirmed',
            confirmTransactionInitialTimeout: 60000,
            wsEndpoint: wsEndpoint
        });
    }

    public getKeyPair(): Keypair {
        const privateKey = this.getPrivateKey();
        const keyArray = JSON.parse(privateKey);
        return Keypair.fromSecretKey(new Uint8Array(keyArray));
    }
}
