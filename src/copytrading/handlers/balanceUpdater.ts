//balanceUpdater.ts
import { EventEmitter } from "events";
import { default as Client } from "@triton-one/yellowstone-grpc";
import { CommitmentLevel, SubscribeRequest } from "@triton-one/yellowstone-grpc";
import { Connection, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import chalk from "chalk";
import { COLORS } from "../../cli/config";

interface BalanceMonitorConfig {
    grpcEndpoint: string;
    rpcEndpoint: string;
    xToken?: string;
    commitment?: CommitmentLevel;
    wallet: string;
}

interface BalanceMonitorStatus {
    isActive: boolean;
    currentBalance: number;
    lastUpdateTime?: Date;
    lastUpdateSlot?: number;
}

export class BalanceMonitor extends EventEmitter {
    private static instance: BalanceMonitor | null = null;
    private client: Client;
    private status: BalanceMonitorStatus;
    private config: BalanceMonitorConfig;
    private subscription: any;
    private pingInterval: NodeJS.Timeout | null = null;
    private readonly PING_INTERVAL_MS = 30000;
    private readonly MAX_RECONNECT_ATTEMPTS = 5;
    private reconnectAttempts = 0;

    private constructor(config: BalanceMonitorConfig) {
        super();
        this.config = config;
        this.status = {
            isActive: false,
            currentBalance: 0
        };

        this.client = new Client(
            config.grpcEndpoint,
            config.xToken,
            {
                commitment: config.commitment || CommitmentLevel.PROCESSED,
                "grpc.keepalive_time_ms": 120000,
                "grpc.http2.min_time_between_pings_ms": 120000,
                "grpc.keepalive_timeout_ms": 20000,
                "grpc.http2.max_pings_without_data": 0,
                "grpc.keepalive_permit_without_calls": 1
            }
        );
    }

    public static getInstance(): BalanceMonitor {
        if (!BalanceMonitor.instance) {
            throw new Error(chalk.hex(COLORS.ERROR)("Balance Monitor not initialized. Call initialize first."));
        }
        return BalanceMonitor.instance;
    }

    public static async initialize(config: BalanceMonitorConfig): Promise<BalanceMonitor> {
        if (!BalanceMonitor.instance) {
            BalanceMonitor.instance = new BalanceMonitor(config);
            
            // Remove this log
            // console.log(chalk.hex(COLORS.PRIMARY)('Initializing balance monitor...'));
            const connection = new Connection(config.rpcEndpoint);
            const initialBalance = await connection.getBalance(new PublicKey(config.wallet));
            BalanceMonitor.instance.status.currentBalance = initialBalance / LAMPORTS_PER_SOL;
            
            await BalanceMonitor.instance.start();
            // Remove this log
            // console.log(chalk.hex(COLORS.SUCCESS)('Balance monitor initialized'));
        }
        return BalanceMonitor.instance;
    }

    public async start(): Promise<void> {
        if (this.status.isActive) {
            console.warn(chalk.hex(COLORS.ERROR)('Balance Monitor is already running'));
            return;
        }

        try {
            await this.connect();
            this.status.isActive = true;
            this.emit('started', this.status);
            this.setupReconnection();
        } catch (error) {
            console.error(chalk.hex(COLORS.ERROR)('Error starting balance monitor:'), error);
            this.emit('error', {
                type: 'STARTUP_ERROR',
                message: error instanceof Error ? error.message : 'Unknown startup error',
                timestamp: new Date()
            });
            throw error;
        }
    }

    private async connect(): Promise<void> {
        try {
            this.subscription = await this.client.subscribe();

            const request: SubscribeRequest = {
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
                commitment: this.config.commitment || CommitmentLevel.PROCESSED
            };

            this.subscription.on('data', (data: any) => {
                if (data.account?.account) {
                    this.handleAccountUpdate(data.account);
                }
            });

            this.subscription.on('error', (error: Error) => {
                console.error(chalk.hex(COLORS.ERROR)('Stream error:'), error);
                this.emit('error', {
                    type: 'SUBSCRIPTION_ERROR',
                    message: error.message,
                    timestamp: new Date()
                });
            });

            await new Promise<void>((resolve, reject) => {
                this.subscription.write(request, (err: Error | null) => {
                    if (err) {
                        console.error(chalk.hex(COLORS.ERROR)('Error writing subscription:'), err);
                        reject(err);
                    } else {
                        resolve();
                    }
                });
            });

            this.setupPingInterval();

        } catch (error) {
            console.error(chalk.hex(COLORS.ERROR)('Error in connection process:'), error);
            throw error;
        }
    }

    private handleAccountUpdate(accountData: any): void {
        try {
            if (!accountData?.account?.lamports) return;
    
            const newBalance = Number(accountData.account.lamports) / LAMPORTS_PER_SOL;
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
                const changeColor = change >= 0 ? COLORS.SUCCESS : COLORS.ERROR;
                
            }
        } catch (error) {
            console.error(chalk.hex(COLORS.ERROR)('Error processing account update:'), error);
            this.emit('error', {
                type: 'UPDATE_ERROR',
                message: error instanceof Error ? error.message : 'Unknown update error',
                timestamp: new Date()
            });
        }
    }

    private setupPingInterval(): void {
        if (this.pingInterval) {
            clearInterval(this.pingInterval);
        }

        this.pingInterval = setInterval(() => {
            if (this.status.lastUpdateTime) {
                const lastUpdateAge = Date.now() - this.status.lastUpdateTime.getTime();
                if (lastUpdateAge > this.PING_INTERVAL_MS * 2) {
                    console.warn(chalk.hex(COLORS.ERROR)(`No balance updates received for ${Math.round(lastUpdateAge / 1000)}s`));
                    this.attemptReconnect();
                }
            }
        }, this.PING_INTERVAL_MS);
    }

    private setupReconnection(): void {
        this.subscription.on('end', () => {
            console.warn(chalk.hex(COLORS.ERROR)('Subscription ended unexpectedly'));
            this.attemptReconnect();
        });

        this.subscription.on('close', () => {
            console.warn(chalk.hex(COLORS.ERROR)('Subscription closed unexpectedly'));
            this.attemptReconnect();
        });
    }

    private async attemptReconnect(): Promise<void> {
        if (!this.status.isActive) return;

        if (this.reconnectAttempts >= this.MAX_RECONNECT_ATTEMPTS) {
            console.error(chalk.hex(COLORS.ERROR)('Max reconnection attempts reached'));
            this.emit('error', {
                type: 'MAX_RECONNECT_ERROR',
                message: 'Failed to reconnect after maximum attempts',
                timestamp: new Date()
            });
            await this.stop();
            return;
        }

        this.reconnectAttempts++;
        console.log(chalk.hex(COLORS.PRIMARY)(`Attempting to reconnect (attempt ${this.reconnectAttempts}/${this.MAX_RECONNECT_ATTEMPTS})...`));

        try {
            await this.connect();
            this.reconnectAttempts = 0;
            console.log(chalk.hex(COLORS.SUCCESS)('Successfully reconnected'));
        } catch (error) {
            console.error(chalk.hex(COLORS.ERROR)('Reconnection attempt failed:'), error);
            setTimeout(() => this.attemptReconnect(), 5000);
        }
    }

    public getCurrentBalance(): number {
        return this.status.currentBalance;
    }

    public getStatus(): BalanceMonitorStatus {
        return { ...this.status };
    }

    public async stop(): Promise<void> {
        if (!this.status.isActive) return;

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
            console.log(chalk.hex(COLORS.PRIMARY)('Balance monitor stopped'));

        } catch (error) {
            console.error(chalk.hex(COLORS.ERROR)('Error stopping monitor:'), error);
            throw error;
        }
    }
}