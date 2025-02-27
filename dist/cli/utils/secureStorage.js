"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SecureStorage = void 0;
//secureStorage.ts
const crypto_1 = __importDefault(require("crypto"));
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const os_1 = __importDefault(require("os"));
class SecureStorage {
    constructor() {
        const configDir = path_1.default.join(os_1.default.homedir(), '.solana-trading-bot');
        if (!fs_1.default.existsSync(configDir)) {
            fs_1.default.mkdirSync(configDir, { mode: 0o700 });
        }
        this.credentialsPath = path_1.default.join(configDir, 'credentials.enc');
        this.keyPath = path_1.default.join(configDir, 'master.key');
        this.initializeEncryptionKey();
    }
    static getInstance() {
        if (!SecureStorage.instance) {
            SecureStorage.instance = new SecureStorage();
        }
        return SecureStorage.instance;
    }
    initializeEncryptionKey() {
        if (!fs_1.default.existsSync(this.keyPath)) {
            this.encryptionKey = crypto_1.default.randomBytes(32);
            fs_1.default.writeFileSync(this.keyPath, this.encryptionKey, { mode: 0o600 });
        }
        else {
            this.encryptionKey = fs_1.default.readFileSync(this.keyPath);
        }
    }
    encrypt(data) {
        const iv = crypto_1.default.randomBytes(16);
        const cipher = crypto_1.default.createCipheriv('aes-256-gcm', this.encryptionKey, iv);
        let encryptedData = cipher.update(data, 'utf8', 'hex');
        encryptedData += cipher.final('hex');
        const authTag = cipher.getAuthTag();
        return {
            iv: iv.toString('hex'),
            encryptedData: encryptedData + authTag.toString('hex')
        };
    }
    decrypt(encryptedData, iv) {
        const decipher = crypto_1.default.createDecipheriv('aes-256-gcm', this.encryptionKey, Buffer.from(iv, 'hex'));
        const authTag = Buffer.from(encryptedData.slice(-32), 'hex');
        const encryptedText = encryptedData.slice(0, -32);
        decipher.setAuthTag(authTag);
        let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
    }
    saveCredentials(credentials) {
        const encrypted = this.encrypt(JSON.stringify(credentials));
        fs_1.default.writeFileSync(this.credentialsPath, JSON.stringify(encrypted), { mode: 0o600 });
    }
    getCredentials() {
        if (!fs_1.default.existsSync(this.credentialsPath)) {
            return {};
        }
        try {
            const encrypted = JSON.parse(fs_1.default.readFileSync(this.credentialsPath, 'utf8'));
            const decrypted = this.decrypt(encrypted.encryptedData, encrypted.iv);
            return JSON.parse(decrypted);
        }
        catch (error) {
            console.error('Error reading credentials:', error);
            return {};
        }
    }
    updateCredential(key, value) {
        const credentials = this.getCredentials();
        credentials[key] = value;
        this.saveCredentials(credentials);
    }
    clearCredentials() {
        if (fs_1.default.existsSync(this.credentialsPath)) {
            fs_1.default.unlinkSync(this.credentialsPath);
        }
    }
}
exports.SecureStorage = SecureStorage;
