"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.BalanceMonitor = void 0;
//balanceUpdater.ts
const events_1 = require("events");
const yellowstone_grpc_1 = __importDefault(require("@triton-one/yellowstone-grpc"));
const yellowstone_grpc_2 = require("@triton-one/yellowstone-grpc");
const web3_js_1 = require("@solana/web3.js");
const chalk_1 = __importDefault(require("chalk"));
const config_1 = require("../../cli/config");
class BalanceMonitor extends events_1.EventEmitter {
    constructor(config) {
        super();
        this.pingInterval = null;
        this.PING_INTERVAL_MS = 30000;
        this.MAX_RECONNECT_ATTEMPTS = 5;
        this.reconnectAttempts = 0;
        this.config = config;
        this.status = {
            isActive: false,
            currentBalance: 0
        };
        this.client = new yellowstone_grpc_1.default(config.grpcEndpoint, config.xToken, {
            commitment: config.commitment || yellowstone_grpc_2.CommitmentLevel.PROCESSED,
            "grpc.keepalive_time_ms": 120000,
            "grpc.http2.min_time_between_pings_ms": 120000,
            "grpc.keepalive_timeout_ms": 20000,
            "grpc.http2.max_pings_without_data": 0,
            "grpc.keepalive_permit_without_calls": 1
        });
    }
    static getInstance() {
        if (!BalanceMonitor.instance) {
            throw new Error(chalk_1.default.hex(config_1.COLORS.ERROR)("Balance Monitor not initialized. Call initialize first."));
        }
        return BalanceMonitor.instance;
    }
    static async initialize(config) {
        if (!BalanceMonitor.instance) {
            BalanceMonitor.instance = new BalanceMonitor(config);
            // Remove this log
            // console.log(chalk.hex(COLORS.PRIMARY)('Initializing balance monitor...'));
            const connection = new web3_js_1.Connection(config.rpcEndpoint);
            const initialBalance = await connection.getBalance(new web3_js_1.PublicKey(config.wallet));
            BalanceMonitor.instance.status.currentBalance = initialBalance / web3_js_1.LAMPORTS_PER_SOL;
            await BalanceMonitor.instance.start();
            // Remove this log
            // console.log(chalk.hex(COLORS.SUCCESS)('Balance monitor initialized'));
        }
        return BalanceMonitor.instance;
    }
    async start() {
        if (this.status.isActive) {
            console.warn(chalk_1.default.hex(config_1.COLORS.ERROR)('Balance Monitor is already running'));
            return;
        }
        try {
            await this.connect();
            this.status.isActive = true;
            this.emit('started', this.status);
            this.setupReconnection();
        }
        catch (error) {
            console.error(chalk_1.default.hex(config_1.COLORS.ERROR)('Error starting balance monitor:'), error);
            this.emit('error', {
                type: 'STARTUP_ERROR',
                message: error instanceof Error ? error.message : 'Unknown startup error',
                timestamp: new Date()
            });
            throw error;
        }
    }
    async connect() {
        try {
            this.subscription = await this.client.subscribe();
            const request = {
                accounts: {
                    walletBalance: {
                        account: [this.config.wallet],
                        owner: [],
                        filters: []
                    }
                },
                slots: {},
                transactions: {},
                transactionsStatus: {},
                entry: {},
                blocks: {},
                blocksMeta: {},
                accountsDataSlice: [],
                ping: undefined,
                commitment: this.config.commitment || yellowstone_grpc_2.CommitmentLevel.PROCESSED
            };
            this.subscription.on('data', (data) => {
                if (data.account?.account) {
                    this.handleAccountUpdate(data.account);
                }
            });
            this.subscription.on('error', (error) => {
                console.error(chalk_1.default.hex(config_1.COLORS.ERROR)('Stream error:'), error);
                this.emit('error', {
                    type: 'SUBSCRIPTION_ERROR',
                    message: error.message,
                    timestamp: new Date()
                });
            });
            await new Promise((resolve, reject) => {
                this.subscription.write(request, (err) => {
                    if (err) {
                        console.error(chalk_1.default.hex(config_1.COLORS.ERROR)('Error writing subscription:'), err);
                        reject(err);
                    }
                    else {
                        resolve();
                    }
                });
            });
            this.setupPingInterval();
        }
        catch (error) {
            console.error(chalk_1.default.hex(config_1.COLORS.ERROR)('Error in connection process:'), error);
            throw error;
        }
    }
    handleAccountUpdate(accountData) {
        try {
            if (!accountData?.account?.lamports)
                return;
            const newBalance = Number(accountData.account.lamports) / web3_js_1.LAMPORTS_PER_SOL;
            const oldBalance = this.status.currentBalance;
            if (newBalance !== oldBalance) {
                this.status.currentBalance = newBalance;
                this.status.lastUpdateTime = new Date();
                this.status.lastUpdateSlot = accountData.slot;
                this.emit('balanceChange', {
                    oldBalance,
                    newBalance,
                    change: newBalance - oldBalance,
                    timestamp: this.status.lastUpdateTime,
                    slot: this.status.lastUpdateSlot
                });
                const change = newBalance - oldBalance;
                const changeColor = change >= 0 ? config_1.COLORS.SUCCESS : config_1.COLORS.ERROR;
            }
        }
        catch (error) {
            console.error(chalk_1.default.hex(config_1.COLORS.ERROR)('Error processing account update:'), error);
            this.emit('error', {
                type: 'UPDATE_ERROR',
                message: error instanceof Error ? error.message : 'Unknown update error',
                timestamp: new Date()
            });
        }
    }
    setupPingInterval() {
        if (this.pingInterval) {
            clearInterval(this.pingInterval);
        }
        this.pingInterval = setInterval(() => {
            if (this.status.lastUpdateTime) {
                const lastUpdateAge = Date.now() - this.status.lastUpdateTime.getTime();
                if (lastUpdateAge > this.PING_INTERVAL_MS * 2) {
                    console.warn(chalk_1.default.hex(config_1.COLORS.ERROR)(`No balance updates received for ${Math.round(lastUpdateAge / 1000)}s`));
                    this.attemptReconnect();
                }
            }
        }, this.PING_INTERVAL_MS);
    }
    setupReconnection() {
        this.subscription.on('end', () => {
            console.warn(chalk_1.default.hex(config_1.COLORS.ERROR)('Subscription ended unexpectedly'));
            this.attemptReconnect();
        });
        this.subscription.on('close', () => {
            console.warn(chalk_1.default.hex(config_1.COLORS.ERROR)('Subscription closed unexpectedly'));
            this.attemptReconnect();
        });
    }
    async attemptReconnect() {
        if (!this.status.isActive)
            return;
        if (this.reconnectAttempts >= this.MAX_RECONNECT_ATTEMPTS) {
            console.error(chalk_1.default.hex(config_1.COLORS.ERROR)('Max reconnection attempts reached'));
            this.emit('error', {
                type: 'MAX_RECONNECT_ERROR',
                message: 'Failed to reconnect after maximum attempts',
                timestamp: new Date()
            });
            await this.stop();
            return;
        }
        this.reconnectAttempts++;
        console.log(chalk_1.default.hex(config_1.COLORS.PRIMARY)(`Attempting to reconnect (attempt ${this.reconnectAttempts}/${this.MAX_RECONNECT_ATTEMPTS})...`));
        try {
            await this.connect();
            this.reconnectAttempts = 0;
            console.log(chalk_1.default.hex(config_1.COLORS.SUCCESS)('Successfully reconnected'));
        }
        catch (error) {
            console.error(chalk_1.default.hex(config_1.COLORS.ERROR)('Reconnection attempt failed:'), error);
            setTimeout(() => this.attemptReconnect(), 5000);
        }
    }
    getCurrentBalance() {
        return this.status.currentBalance;
    }
    getStatus() {
        return { ...this.status };
    }
    async stop() {
        if (!this.status.isActive)
            return;
        try {
            if (this.pingInterval) {
                clearInterval(this.pingInterval);
                this.pingInterval = null;
            }
            if (this.subscription) {
                this.subscription.end();
                this.subscription = null;
            }
            this.status.isActive = false;
            this.emit('stopped', this.status);
            console.log(chalk_1.default.hex(config_1.COLORS.PRIMARY)('Balance monitor stopped'));
        }
        catch (error) {
            console.error(chalk_1.default.hex(config_1.COLORS.ERROR)('Error stopping monitor:'), error);
            throw error;
        }
    }
}
exports.BalanceMonitor = BalanceMonitor;
BalanceMonitor.instance = null;
