//credentialsManager.ts
import { Connection, PublicKey, Keypair } from '@solana/web3.js';
import { SecureStorage } from './secureStorage';
import bs58 from 'bs58';

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

    public async validateRpcUrl(url: string): Promise<boolean> {
        try {
            const connection = new Connection(url);
            await connection.getLatestBlockhash();
            return true;
        } catch {
            return false;
        }
    }

    public async validateGrpcUrl(url: string): Promise<boolean> {
        try {
            // Basic URL validation
            new URL(url);
            return true;
        } catch {
            return false;
        }
    }

    public async validateAuthToken(token: string): Promise<boolean> {
        return token.length > 0;  // Just ensure it's not empty
    }

    public async validateAndConvertPrivateKey(base58Key: string): Promise<string> {
        try {
            // Validate base58 format
            if (!/^[1-9A-HJ-NP-Za-km-z]{87,88}$/.test(base58Key)) {
                throw new Error('Invalid base58 format');
            }

            // Decode base58 key
            const decoded = bs58.decode(base58Key);
            
            // Convert to number array
            const keyArray = Array.from(decoded);
            
            // Verify it's a valid keypair
            try {
                Keypair.fromSecretKey(new Uint8Array(keyArray));
            } catch {
                throw new Error('Invalid private key');
            }

            // Return as JSON string in the format your code expects
            return JSON.stringify(keyArray);
        } catch (error) {
            throw new Error('Invalid private key format');
        }
    }

    async validateWsEndpoint(url: string): Promise<boolean> {
        try {
            // Basic WebSocket URL validation
            if (!url.startsWith('ws://') && !url.startsWith('wss://')) {
                return false;
            }
            new URL(url);
            return true;
        } catch {
            return false;
        }
    }

    getWsEndpoint(): string {
        const credentials = this.secureStorage.getCredentials();
        if (!credentials.wsEndpoint) {
            throw new Error('WebSocket endpoint not configured');
        }
        return credentials.wsEndpoint;
    }

    async setWsEndpoint(url: string): Promise<void> {
        if (!await this.validateWsEndpoint(url)) {
            throw new Error('Invalid WebSocket URL format');
        }
        this.secureStorage.updateCredential('wsEndpoint', url);
    }

    // RPC URL methods
    public getRpcUrl(): string {
        const credentials = this.secureStorage.getCredentials();
        if (!credentials.rpcUrl) {
            throw new Error('RPC URL not configured');
        }
        return credentials.rpcUrl;
    }

    public async setRpcUrl(url: string): Promise<void> {
        if (!await this.validateRpcUrl(url)) {
            throw new Error('Invalid RPC URL - failed to connect');
        }
        this.secureStorage.updateCredential('rpcUrl', url);
        
        // Verify the update
        const stored = this.secureStorage.getCredentials().rpcUrl;
        if (stored !== url) {
            throw new Error('Failed to persist RPC URL update');
        }
    }

    // GRPC URL methods
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
    }

    // Auth Token methods
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
    }

    // Private Key methods
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
    }

    // General credential methods
    public hasCredentials(): boolean {
        const credentials = this.secureStorage.getCredentials();
        return Boolean(
            credentials.rpcUrl && 
            credentials.privateKey && 
            credentials.grpcUrl && 
            credentials.authToken
        );
    }

    public hasBasicCredentials(): boolean {
        const credentials = this.secureStorage.getCredentials();
        return Boolean(credentials.rpcUrl && credentials.privateKey);
    }

    public clearCredentials(): void {
        this.secureStorage.clearCredentials();
    }

    public getConnection(): Connection {
        const wsEndpoint = this.secureStorage.getCredentials().wsEndpoint;
        return new Connection(this.getRpcUrl(), {
            commitment: 'confirmed',
            confirmTransactionInitialTimeout: 60000,
            wsEndpoint: wsEndpoint
        });
    }

    // Helper method to get a Keypair directly
    public getKeyPair(): Keypair {
        const privateKey = this.getPrivateKey();
        const keyArray = JSON.parse(privateKey);
        return Keypair.fromSecretKey(new Uint8Array(keyArray));
    }
}