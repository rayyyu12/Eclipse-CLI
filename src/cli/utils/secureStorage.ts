//secureStorage.ts
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';

export interface SecureCredentials {
    rpcUrl?: string;
    grpcUrl?: string;
    authToken?: string;
    privateKey?: string;
    monitoredWallets?: string;
    wsEndpoint?: string;  // Add this line
}

export class SecureStorage {
    private static instance: SecureStorage;
    private readonly credentialsPath: string;
    private readonly keyPath: string;
    private encryptionKey?: Buffer;

    private constructor() {
        const configDir = path.join(os.homedir(), '.solana-trading-bot');
        if (!fs.existsSync(configDir)) {
            fs.mkdirSync(configDir, { mode: 0o700 });
        }
        
        this.credentialsPath = path.join(configDir, 'credentials.enc');
        this.keyPath = path.join(configDir, 'master.key');
        this.initializeEncryptionKey();
    }

    public static getInstance(): SecureStorage {
        if (!SecureStorage.instance) {
            SecureStorage.instance = new SecureStorage();
        }
        return SecureStorage.instance;
    }

    private initializeEncryptionKey(): void {
        if (!fs.existsSync(this.keyPath)) {
            this.encryptionKey = crypto.randomBytes(32);
            fs.writeFileSync(this.keyPath, this.encryptionKey, { mode: 0o600 });
        } else {
            this.encryptionKey = fs.readFileSync(this.keyPath);
        }
    }

    private encrypt(data: string): { iv: string; encryptedData: string } {
        const iv = crypto.randomBytes(16);
        const cipher = crypto.createCipheriv('aes-256-gcm', this.encryptionKey!, iv);
        
        let encryptedData = cipher.update(data, 'utf8', 'hex');
        encryptedData += cipher.final('hex');
        
        const authTag = cipher.getAuthTag();
        
        return {
            iv: iv.toString('hex'),
            encryptedData: encryptedData + authTag.toString('hex')
        };
    }

    private decrypt(encryptedData: string, iv: string): string {
        const decipher = crypto.createDecipheriv(
            'aes-256-gcm', 
            this.encryptionKey!, 
            Buffer.from(iv, 'hex')
        );
        
        const authTag = Buffer.from(encryptedData.slice(-32), 'hex');
        const encryptedText = encryptedData.slice(0, -32);
        
        decipher.setAuthTag(authTag);
        
        let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        
        return decrypted;
    }

    public saveCredentials(credentials: SecureCredentials): void {
        const encrypted = this.encrypt(JSON.stringify(credentials));
        fs.writeFileSync(this.credentialsPath, JSON.stringify(encrypted), { mode: 0o600 });
    }

    public getCredentials(): SecureCredentials {
        if (!fs.existsSync(this.credentialsPath)) {
            return {};
        }

        try {
            const encrypted = JSON.parse(fs.readFileSync(this.credentialsPath, 'utf8'));
            const decrypted = this.decrypt(encrypted.encryptedData, encrypted.iv);
            return JSON.parse(decrypted);
        } catch (error) {
            console.error('Error reading credentials:', error);
            return {};
        }
    }

    public updateCredential(key: keyof SecureCredentials, value: string | undefined): void {
        const credentials = this.getCredentials();
        credentials[key] = value;
        this.saveCredentials(credentials);
    }

    public clearCredentials(): void {
        if (fs.existsSync(this.credentialsPath)) {
            fs.unlinkSync(this.credentialsPath);
        }
    }
}