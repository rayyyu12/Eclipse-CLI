"use strict";
// src/cli/utils/credentialsManager.ts
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CredentialsManager = void 0;
const web3_js_1 = require("@solana/web3.js");
const secureStorage_1 = require("./secureStorage");
const bs58_1 = __importDefault(require("bs58"));
const chalk_1 = __importDefault(require("chalk"));
const config_1 = require("../config");
class CredentialsManager {
    constructor() {
        this.secureStorage = secureStorage_1.SecureStorage.getInstance();
    }
    static getInstance() {
        if (!CredentialsManager.instance) {
            CredentialsManager.instance = new CredentialsManager();
        }
        return CredentialsManager.instance;
    }
    // Validation Methods
    async validateRpcUrl(url) {
        try {
            const connection = new web3_js_1.Connection(url);
            await connection.getLatestBlockhash();
            return true;
        }
        catch (error) {
            console.error(chalk_1.default.hex(config_1.COLORS.ERROR)('RPC URL validation failed:'), error);
            return false;
        }
    }
    async validateGrpcUrl(url) {
        try {
            new URL(url);
            return true;
        }
        catch (error) {
            console.error(chalk_1.default.hex(config_1.COLORS.ERROR)('GRPC URL validation failed:'), error);
            return false;
        }
    }
    async validateAuthToken(token) {
        return token.length > 0;
    }
    async validateAndConvertPrivateKey(base58Key) {
        try {
            if (!/^[1-9A-HJ-NP-Za-km-z]{87,88}$/.test(base58Key)) {
                throw new Error('Invalid base58 format');
            }
            const decoded = bs58_1.default.decode(base58Key);
            const keyArray = Array.from(decoded);
            try {
                web3_js_1.Keypair.fromSecretKey(new Uint8Array(keyArray));
            }
            catch {
                throw new Error('Invalid private key');
            }
            return JSON.stringify(keyArray);
        }
        catch (error) {
            throw new Error('Invalid private key format');
        }
    }
    async validateWsEndpoint(url) {
        try {
            if (!url.startsWith('ws://') && !url.startsWith('wss://')) {
                return false;
            }
            new URL(url);
            return true;
        }
        catch (error) {
            console.error(chalk_1.default.hex(config_1.COLORS.ERROR)('WebSocket URL validation failed:'), error);
            return false;
        }
    }
    // WebSocket Methods
    getWsEndpoint() {
        const credentials = this.secureStorage.getCredentials();
        if (!credentials.wsEndpoint) {
            throw new Error('WebSocket endpoint not configured');
        }
        return credentials.wsEndpoint;
    }
    async setWsEndpoint(url) {
        if (!await this.validateWsEndpoint(url)) {
            throw new Error('Invalid WebSocket URL format');
        }
        this.secureStorage.updateCredential('wsEndpoint', url);
        console.log(chalk_1.default.hex(config_1.COLORS.SUCCESS)('WebSocket endpoint updated successfully'));
    }
    // RPC URL Methods
    getRpcUrl() {
        const credentials = this.secureStorage.getCredentials();
        if (!credentials.rpcUrl) {
            throw new Error('RPC URL not configured');
        }
        return credentials.rpcUrl;
    }
    async setRpcUrl(url) {
        if (!await this.validateRpcUrl(url)) {
            throw new Error('Invalid RPC URL - connection failed');
        }
        this.secureStorage.updateCredential('rpcUrl', url);
        const stored = this.secureStorage.getCredentials().rpcUrl;
        if (stored !== url) {
            throw new Error('Failed to persist RPC URL update');
        }
        console.log(chalk_1.default.hex(config_1.COLORS.SUCCESS)('RPC URL updated successfully'));
    }
    // GRPC URL Methods
    getGrpcUrl() {
        const credentials = this.secureStorage.getCredentials();
        if (!credentials.grpcUrl) {
            throw new Error('GRPC URL not configured');
        }
        return credentials.grpcUrl;
    }
    async setGrpcUrl(url) {
        if (!await this.validateGrpcUrl(url)) {
            throw new Error('Invalid GRPC URL format');
        }
        this.secureStorage.updateCredential('grpcUrl', url);
        console.log(chalk_1.default.hex(config_1.COLORS.SUCCESS)('GRPC URL updated successfully'));
    }
    // Auth Token Methods
    getAuthToken() {
        const credentials = this.secureStorage.getCredentials();
        if (!credentials.authToken) {
            throw new Error('Auth token not configured');
        }
        return credentials.authToken;
    }
    async setAuthToken(token) {
        if (!await this.validateAuthToken(token)) {
            throw new Error('Invalid auth token format');
        }
        this.secureStorage.updateCredential('authToken', token);
        console.log(chalk_1.default.hex(config_1.COLORS.SUCCESS)('Auth token updated successfully'));
    }
    // Private Key Methods
    getPrivateKey() {
        const credentials = this.secureStorage.getCredentials();
        if (!credentials.privateKey) {
            throw new Error('Private key not configured');
        }
        return credentials.privateKey;
    }
    async setPrivateKey(base58Key) {
        const convertedKey = await this.validateAndConvertPrivateKey(base58Key);
        this.secureStorage.updateCredential('privateKey', convertedKey);
        console.log(chalk_1.default.hex(config_1.COLORS.SUCCESS)('Private key updated successfully'));
    }
    // General Credential Methods
    hasCredentials() {
        const credentials = this.secureStorage.getCredentials();
        const hasCreds = Boolean(credentials.rpcUrl &&
            credentials.privateKey);
        return hasCreds;
    }
    hasBasicCredentials() {
        const credentials = this.secureStorage.getCredentials();
        return Boolean(credentials.rpcUrl && credentials.privateKey);
    }
    clearCredentials() {
        this.secureStorage.clearCredentials();
        console.log(chalk_1.default.hex(config_1.COLORS.SUCCESS)('All credentials cleared successfully'));
    }
    // Connection Methods
    getConnection() {
        const wsEndpoint = this.secureStorage.getCredentials().wsEndpoint;
        return new web3_js_1.Connection(this.getRpcUrl(), {
            commitment: 'confirmed',
            confirmTransactionInitialTimeout: 60000,
            wsEndpoint: wsEndpoint
        });
    }
    getKeyPair() {
        const privateKey = this.getPrivateKey();
        const keyArray = JSON.parse(privateKey);
        return web3_js_1.Keypair.fromSecretKey(new Uint8Array(keyArray));
    }
}
exports.CredentialsManager = CredentialsManager;
