// -------------------------------------------------------------
// transactionmonitor.ts (updated)
// -------------------------------------------------------------
import { EventEmitter } from "events";
import { default as Client, CommitmentLevel } from "@triton-one/yellowstone-grpc";
import { PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { NATIVE_MINT, getAssociatedTokenAddress } from "@solana/spl-token";
import bs58 from "bs58";
import chalk from 'chalk';

import {
    PUMP_FUN_PROGRAM_ID,
    RAYDIUM_AMM_PROGRAM_ID,
} from "../../utils/swaps/constants";
import {
    SwapType,
    RaydiumSwapData
} from "../../copytrading/types/types";
import { CredentialsManager } from "../../cli/utils/credentialsManager";
import { copyRaydiumSwap } from "./swaps/raydiumCopySwap";
import { copyPumpBuySwap, copyPumpSellSwap } from "./swaps/pumpCopySwap";
import { PortfolioTracker } from '../../utils/positions/portfolioTracker';
import { deriveInstructionDiscriminator } from '../../utils/swaps/pumpSwap';
import { CopyTradeSettingsManager, BuyMode } from "../../cli/utils/copyTradingSettings";
import { COLORS } from "../../cli/config";

// Import interfaces from existing document...
interface MonitorStatus {
    isActive: boolean;
    processedTransactions: number;
    detectedSwaps: number;
    successfulCopies: number;
    failedCopies: number;
    connectedAt?: Date;
    lastTransactionAt?: Date;
}

interface TokenBalance {
    accountIndex: number;
    mint: string;
    owner: string;
    uiTokenAmount: {
        uiAmount: number | null;
        decimals: number;
        amount: string;
        uiAmountString: string;
    };
}

interface PumpSwapData {
    swapType: SwapType.PUMP;
    tokenAddress: PublicKey;
    bondingCurve: PublicKey;
    associatedBondingCurve: PublicKey;
    virtualTokenReserves: string;
    virtualSolReserves: string;
    walletAddress: string;
    isBuy: boolean;
    success: boolean;
    amountIn?: number;
    amountOut?: number;
    signature?: string;
    timestamp?: Date;
    userTokenAccount?: PublicKey;
    decimalsIn?: number;
    decimalsOut?: number;
}

export class TransactionMonitor extends EventEmitter {
    private client: Client;
    private status: MonitorStatus;
    private config: {
        grpcEndpoint: string;
        xToken?: string;
        commitment?: CommitmentLevel;
        wallets: string[];
        enablePump: boolean;
        enableRaydium: boolean;
    };
    private subscription: any;
    private pingInterval: NodeJS.Timeout | null = null;
    private cleanupInterval: NodeJS.Timeout | null = null;
    private readonly PING_INTERVAL_MS = 30000;
    private readonly MAX_RECONNECT_ATTEMPTS = 5;
    private reconnectAttempts = 0;
    private readonly MAX_PROCESSED_TRANSACTIONS = 1000;
    private walletSet: Set<string>;
    private processedTransactions: Set<string> = new Set();

    constructor(config: {
        grpcEndpoint: string;
        xToken?: string;
        commitment?: CommitmentLevel;
        wallets: string[];
        enablePump: boolean;
        enableRaydium: boolean;
    }) {
        super();
        this.config = config;
        this.walletSet = new Set(config.wallets);
        this.status = {
            isActive: false,
            processedTransactions: 0,
            detectedSwaps: 0,
            successfulCopies: 0,
            failedCopies: 0
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
                "grpc.keepalive_permit_without_calls": 1,
                "grpc.max_receive_message_length": 64 * 1024 * 1024
            }
        );

        this.setupCleanupInterval();
    }

    public async start(): Promise<void> {
        if (this.status.isActive) {
            console.warn(chalk.hex(COLORS.ERROR)('Monitor is already running'));
            return;
        }

        try {
            console.log(chalk.hex(COLORS.PRIMARY)('Initializing portfolio tracker...'));
            const portfolioTracker = PortfolioTracker.getInstance();
            await portfolioTracker.initializeBalanceMonitoring();
            console.log(chalk.hex(COLORS.SUCCESS)('Portfolio tracker initialized'));

            await this.connect();
            this.status.isActive = true;
            this.status.connectedAt = new Date();
            this.emit('started', this.status);
            this.setupReconnection();
        } catch (error) {
            console.error(chalk.hex(COLORS.ERROR)('Error starting monitor:'), error);
            this.emit('error', {
                type: 'STARTUP_ERROR',
                message: error instanceof Error ? error.message : 'Unknown startup error',
                timestamp: new Date()
            });
            throw error;
        }
    }

    public async stop(): Promise<void> {
        if (!this.status.isActive) return;

        try {
            if (this.pingInterval) {
                clearInterval(this.pingInterval);
                this.pingInterval = null;
            }
            if (this.cleanupInterval) {
                clearInterval(this.cleanupInterval);
                this.cleanupInterval = null;
            }
            if (this.subscription) {
                this.subscription.end();
                this.subscription = null;
            }

            this.status.isActive = false;
            this.emit('stopped', this.status);

        } catch (error) {
            console.error(chalk.hex(COLORS.ERROR)('Error stopping monitor:'), error);
            throw error;
        }
    }

    private async connect(): Promise<void> {
        try {
            this.subscription = await this.client.subscribe();

            const programsToMonitor: string[] = [];
            if (this.config.enablePump) programsToMonitor.push(PUMP_FUN_PROGRAM_ID.toBase58());
            if (this.config.enableRaydium) programsToMonitor.push(RAYDIUM_AMM_PROGRAM_ID.toBase58());

            if (programsToMonitor.length === 0) {
                throw new Error('At least one program must be enabled for monitoring');
            }

            console.log(chalk.hex(COLORS.PRIMARY)('Configuring monitors for wallets:'), this.config.wallets);
            console.log(chalk.hex(COLORS.PRIMARY)('Programs being monitored:'), programsToMonitor);

            const request = {
                accounts: {},
                slots: {},
                transactions: {
                    swapTransactions: {
                        vote: false,
                        failed: false,
                        signature: undefined,
                        accountInclude: programsToMonitor,
                        accountExclude: [],
                        accountRequired: this.config.wallets.length > 0 ? this.config.wallets : undefined,
                    }
                },
                transactionsStatus: {},
                entry: {},
                blocks: {},
                blocksMeta: {},
                accountsDataSlice: [],
                ping: undefined,
                commitment: this.config.commitment || CommitmentLevel.PROCESSED
            };

            this.subscription.on('data', (data: any) => {
                if (data.transaction?.transaction) {
                    this.status.processedTransactions++;
                    this.handleTransaction(data.transaction);
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
                        console.log(chalk.hex(COLORS.SUCCESS)('Successfully subscribed to transaction stream'));
                        resolve();
                    }
                });
            });

            this.setupPingInterval();
            console.log(chalk.hex(COLORS.SUCCESS)('Transaction monitor fully initialized'));

        } catch (error) {
            console.error(chalk.hex(COLORS.ERROR)('Error in connection process:'), error);
            throw error;
        }
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

    private setupPingInterval(): void {
        if (this.pingInterval) clearInterval(this.pingInterval);
        
        this.pingInterval = setInterval(() => {
            const status = this.getStatus();
            if (status.lastTransactionAt) {
                const lastTxAge = Date.now() - status.lastTransactionAt.getTime();
                if (lastTxAge > this.PING_INTERVAL_MS * 2) {
                    console.warn(chalk.hex(COLORS.ERROR)(`No transactions received for ${Math.round(lastTxAge / 1000)}s`));
                    this.attemptReconnect();
                }
            }
        }, this.PING_INTERVAL_MS);
    }

    private setupCleanupInterval(): void {
        if (this.cleanupInterval) clearInterval(this.cleanupInterval);
        
        this.cleanupInterval = setInterval(() => {
            if (this.processedTransactions.size > this.MAX_PROCESSED_TRANSACTIONS) {
                const transactions = Array.from(this.processedTransactions);
                const toKeep = transactions.slice(-this.MAX_PROCESSED_TRANSACTIONS);
                this.processedTransactions = new Set(toKeep);
            }
        }, 60 * 60 * 1000);
    }

    private async handleTransaction(tx: any): Promise<void> {
        try {
            if (!tx.transaction?.signature) return;

            const signature = tx.transaction.signature instanceof Uint8Array
                ? bs58.encode(tx.transaction.signature)
                : tx.transaction.signature?.type === 'Buffer'
                    ? bs58.encode(Buffer.from(tx.transaction.signature.data))
                    : tx.transaction.signature;

            if (this.processedTransactions.has(signature)) return;
            this.processedTransactions.add(signature);

            const walletAddress = await this.extractWalletAddress(tx);
            if (!walletAddress || !this.walletSet.has(walletAddress)) return;

            const botWallet = CredentialsManager.getInstance().getKeyPair().publicKey.toString();
            if (walletAddress === botWallet) return;

            const logs = tx.transaction.meta?.logMessages || [];
            const isPumpTransaction = logs.some((log: any) =>
                (typeof log === 'string' ? log : log.message).includes('Program ' + PUMP_FUN_PROGRAM_ID.toString())
            );
            const isRaydiumTransaction = logs.some((log: any) =>
                (typeof log === 'string' ? log : log.message).includes('ray_log:')
            );

            if (!isPumpTransaction && !isRaydiumTransaction) return;

            let swapData: RaydiumSwapData | PumpSwapData | null = null;

            if (isPumpTransaction) {
                swapData = this.extractPumpSwapDetails(tx, walletAddress);
                if (swapData?.success && swapData?.amountIn !== undefined && swapData?.amountOut !== undefined) {
                    await this.executeCopyTrade(swapData, signature);
                }
            } else {
                const rayLog = logs.find((log: any) => 
                    (typeof log === 'string' ? log : log.message).includes('ray_log:')
                );
                if (!rayLog) return;

                const poolAccountsData = await this.extractRaydiumPoolAccounts(tx);
                if (!poolAccountsData) return;

                const [preBalances, postBalances] = [
                    tx.transaction.meta?.preTokenBalances || [],
                    tx.transaction.meta?.postTokenBalances || []
                ];
                
                const tokenChanges = this.calculateTokenChanges(preBalances, postBalances);
                const swapDetails = await this.extractSwapDetails(tx, walletAddress, poolAccountsData, preBalances, postBalances);
                
                if (!tokenChanges || !swapDetails) return;

                const swapDirection = this.detectSwapDirection(preBalances, postBalances, swapDetails.poolBalances);

                swapData = {
                    swapType: SwapType.RAYDIUM,
                    tokenAddress: tokenChanges.tokenMint,
                    ammId: poolAccountsData.ammId,
                    ammAuthority: poolAccountsData.ammAuthority,
                    ammOpenOrders: poolAccountsData.ammOpenOrders,
                    ammTargetOrders: poolAccountsData.ammTargetOrders,
                    poolCoinTokenAccount: poolAccountsData.poolCoinTokenAccount,
                    poolPcTokenAccount: poolAccountsData.poolPcTokenAccount,
                    poolLpTokenAccount: poolAccountsData.poolLpTokenAccount,
                    poolTempLpTokenAccount: poolAccountsData.poolTempLpTokenAccount,
                    serumProgramId: poolAccountsData.serumProgramId,
                    serumMarket: poolAccountsData.serumMarket,
                    serumBids: poolAccountsData.serumBids,
                    serumAsks: poolAccountsData.serumAsks,
                    serumEventQueue: poolAccountsData.serumEventQueue,
                    serumBaseVault: poolAccountsData.serumBaseVault,
                    serumQuoteVault: poolAccountsData.serumQuoteVault,
                    serumOpenOrders: poolAccountsData.serumOpenOrders,
                    tokenInMint: tokenChanges.tokenIn,
                    tokenOutMint: tokenChanges.tokenOut,
                    success: (tx.transaction.meta?.err == null),
                    walletAddress,
                    isBuy: swapDirection === 'buy',
                    poolBalances: swapDetails.poolBalances,
                    amountIn: tokenChanges.amountIn,
                    amountOut: tokenChanges.amountOut,
                    signature,
                    programId: RAYDIUM_AMM_PROGRAM_ID.toBase58(),
                    rayLogData: (typeof rayLog === 'string' ? rayLog : rayLog.message).split('ray_log: ')[1],
                    timestamp: new Date(),
                    userAccounts: Object.fromEntries(swapDetails.userAccounts),
                    slot: swapDetails.slot,
                    decimalsIn: tokenChanges.decimalsIn,
                    decimalsOut: tokenChanges.decimalsOut
                };

                if (swapData.success) {
                    await this.executeCopyTrade(swapData, signature);
                }
            }

            if (!swapData) return;

            this.status.lastTransactionAt = new Date();
            this.status.detectedSwaps++;
            
            if (swapData.success) {
                this.status.successfulCopies++;
            } else {
                this.status.failedCopies++;
            }

            this.emit('swap', swapData);

        } catch (error) {
            console.error(chalk.hex(COLORS.ERROR)('Error processing transaction:'), error);
            this.emit('error', {
                type: 'PARSE_ERROR',
                message: error instanceof Error ? error.message : 'Unknown error processing transaction',
                timestamp: new Date()
            });
        }
    }

    // -------------------------------------------------------------------------
    // COPY TRADE EXECUTION
    // -------------------------------------------------------------------------
    private async executeCopyTrade(swapData: RaydiumSwapData | PumpSwapData, originalSignature: string): Promise<void> {
        try {
            const credManager = CredentialsManager.getInstance();
            const connection = credManager.getConnection();
            const wallet = credManager.getKeyPair();
            const settings = CopyTradeSettingsManager.getInstance().getSettings();

            if (swapData.swapType === SwapType.PUMP && !settings.enabled.pump) {
                throw new Error('Pump.fun trading is disabled in settings');
            }
            if (swapData.swapType === SwapType.RAYDIUM && !settings.enabled.raydium) {
                throw new Error('Raydium trading is disabled in settings');
            }

            console.log(chalk.hex(COLORS.PRIMARY)('\nExecuting copy trade...'));
            console.log(`Original tx: ${chalk.hex(COLORS.ACCENT)(originalSignature)}`);
            console.log(`Type: ${chalk.hex(COLORS.ACCENT)(swapData.isBuy ? 'BUY' : 'SELL')}`);
            console.log(`Protocol: ${chalk.hex(COLORS.ACCENT)(swapData.swapType)}`);

            let copySignature: string;

            if (swapData.swapType === SwapType.PUMP) {
                const pumpData = swapData as PumpSwapData;
                if (!pumpData.amountOut || !pumpData.amountIn) {
                    throw new Error('Missing swap amounts in original transaction');
                }

                if (pumpData.isBuy) {
                    let amountInLamports = settings.buyMode === BuyMode.FIXED ? 
                        settings.fixedBuyAmount * LAMPORTS_PER_SOL : 
                        pumpData.amountIn * LAMPORTS_PER_SOL;

                    const amountInSol = amountInLamports / LAMPORTS_PER_SOL;
                    if (amountInSol < settings.minBuyAmount) {
                        throw new Error(`Buy amount ${amountInSol} SOL below minimum ${settings.minBuyAmount} SOL`);
                    }
                    if (amountInSol > settings.maxBuyAmount) {
                        throw new Error(`Buy amount ${amountInSol} SOL above maximum ${settings.maxBuyAmount} SOL`);
                    }

                    copySignature = await copyPumpBuySwap(connection, wallet, pumpData, amountInLamports);
                } else {
                    const portfolioTracker = PortfolioTracker.getInstance();
                    const position = await portfolioTracker.getPosition(pumpData.tokenAddress.toString());

                    if (!position) {
                        const userTokenAccount = await getAssociatedTokenAddress(
                            pumpData.tokenAddress,
                            wallet.publicKey
                        );
                        const accountInfo = await connection.getTokenAccountBalance(userTokenAccount);
                        if (!accountInfo?.value?.uiAmount || accountInfo.value.uiAmount <= 0) {
                            throw new Error('No tokens available to sell');
                        }
                        const tokenBalance = accountInfo.value.uiAmount;
                        const amountToSell = Math.floor(tokenBalance * Math.pow(10, 6));
                        copySignature = await copyPumpSellSwap(
                            connection, 
                            wallet, 
                            pumpData, 
                            amountToSell,
                            settings.slippageTolerance.pump / 100
                        );
                    } else {
                        const tokenBalance = position.remainingValue / position.currentPriceSol;
                        const amountToSell = Math.floor(tokenBalance * Math.pow(10, 6));
                        copySignature = await copyPumpSellSwap(
                            connection, 
                            wallet, 
                            pumpData, 
                            amountToSell,
                            settings.slippageTolerance.pump / 100
                        );
                    }
                }
            } else {
                const raydiumData = swapData as RaydiumSwapData;
                if (!raydiumData.poolBalances?.coin || !raydiumData.poolBalances?.pc) {
                    throw new Error("Missing pool balance information");
                }

                const userToken = Object.values(raydiumData.userAccounts || {}).find(
                    (acct: any) => acct.mint === raydiumData.tokenAddress.toString()
                );
                const tokenDecimals = userToken?.decimals || 6;

                if (raydiumData.isBuy) {
                    let amountInLamports = settings.buyMode === BuyMode.FIXED ? 
                        settings.fixedBuyAmount * LAMPORTS_PER_SOL : 
                        raydiumData.amountIn! * LAMPORTS_PER_SOL;

                    const amountInSol = amountInLamports / LAMPORTS_PER_SOL;
                    if (amountInSol < settings.minBuyAmount) {
                        throw new Error(`Buy amount ${amountInSol} SOL below minimum ${settings.minBuyAmount} SOL`);
                    }
                    if (amountInSol > settings.maxBuyAmount) {
                        throw new Error(`Buy amount ${amountInSol} SOL above maximum ${settings.maxBuyAmount} SOL`);
                    }

                    copySignature = await copyRaydiumSwap(connection, wallet, raydiumData, amountInLamports);
                } else {
                    const portfolioTracker = PortfolioTracker.getInstance();
                    const position = await portfolioTracker.getPosition(raydiumData.tokenAddress.toString());
                    
                    if (!position) {
                        throw new Error('No token position found for selling');
                    }

                    const tokenAmount = position.remainingValue / position.currentPriceSol;
                    const amountToSell = Math.floor(tokenAmount * Math.pow(10, tokenDecimals));

                    copySignature = await copyRaydiumSwap(
                        connection,
                        wallet,
                        {
                            ...raydiumData,
                            tokenInMint: raydiumData.tokenAddress.toString(),
                            tokenOutMint: NATIVE_MINT.toString()
                        },
                        amountToSell
                    );
                }
            }

            console.log(chalk.hex(COLORS.SUCCESS)('\nCopy Trade Success:'));
            console.log(`Signature: ${chalk.hex(COLORS.ACCENT)(copySignature)}`);
            console.log(`Explorer: ${chalk.hex(COLORS.SUCCESS)(`https://solscan.io/tx/${copySignature}`)}`);

            this.emit('copyTradeSuccess', {
                originalSignature,
                copySignature,
                protocol: swapData.swapType,
                type: swapData.isBuy ? 'BUY' : 'SELL',
                tokenAddress: swapData.tokenAddress.toString()
            });

        } catch (error) {
            console.error(chalk.hex(COLORS.ERROR)('\nCopy trade failed:'), error);
            
            this.emit('copyTradeError', {
                originalSignature,
                error: error instanceof Error ? error.message : 'Unknown error',
                protocol: swapData.swapType,
                type: swapData.isBuy ? 'BUY' : 'SELL',
                tokenAddress: swapData.tokenAddress.toString()
            });

            throw error;
        }
    }

    // -------------------------------------------------------------------------
    // PUMP DETECTION & DETAILS
    // -------------------------------------------------------------------------
    // Continuation of extractPumpSwapDetails in transactionmonitor.ts

    private extractPumpSwapDetails(tx: any, walletAddress: string): PumpSwapData | null {
        try {
            const accounts = tx.transaction?.transaction?.message?.accountKeys;
            const instructions = tx.transaction?.transaction?.message?.instructions;

            const pumpInstruction = instructions?.find((ix: any) => {
                const programId = accounts[ix.programIdIndex];
                return (
                    (programId instanceof Uint8Array || programId?.type === 'Buffer') &&
                    new PublicKey(programId).equals(PUMP_FUN_PROGRAM_ID)
                );
            });
            
            if (!pumpInstruction) return null;

            const data = Buffer.from(pumpInstruction.data);
            const buyDiscriminator = deriveInstructionDiscriminator('global', 'buy');
            const sellDiscriminator = deriveInstructionDiscriminator('global', 'sell');

            const isBuy = data.slice(0, 8).equals(buyDiscriminator);
            const isSell = data.slice(0, 8).equals(sellDiscriminator);
            if (!isBuy && !isSell) return null;

            const getAccountFromIndex = (index: number): PublicKey => {
                const account = accounts[index];
                if (account instanceof Uint8Array) {
                    return new PublicKey(account);
                } else if (account?.type === 'Buffer') {
                    return new PublicKey(Buffer.from(account.data));
                }
                throw new Error(`Invalid account at index ${index}`);
            };

            const keys = pumpInstruction.accounts;
            const mint = getAccountFromIndex(keys[2]);
            const bondingCurve = getAccountFromIndex(keys[3]);
            const associatedBondingCurve = getAccountFromIndex(keys[4]);
            const userTokenAccount = getAccountFromIndex(keys[5]);

            const preBalances = tx.transaction.meta?.preTokenBalances || [];
            const postBalances = tx.transaction.meta?.postTokenBalances || [];
            const tokenPreBalance = preBalances.find((b: TokenBalance) => b.accountIndex === keys[5]);
            const tokenPostBalance = postBalances.find((b: TokenBalance) => b.accountIndex === keys[5]);

            let tokenAmount: number | undefined;
            const preAmount = tokenPreBalance?.uiTokenAmount?.uiAmount ?? 0;
            const postAmount = tokenPostBalance?.uiTokenAmount?.uiAmount;

            if (postAmount !== undefined) {
                tokenAmount = Math.abs(Number(postAmount) - Number(preAmount));
            }

            const accountPreBalances = tx.transaction.meta?.preBalances || [];
            const accountPostBalances = tx.transaction.meta?.postBalances || [];
            const walletIndex = accounts.findIndex((acc: any) => {
                const pk = acc instanceof Uint8Array ? new PublicKey(acc) : new PublicKey(acc.toString());
                return pk.toString() === walletAddress;
            });

            let solChange: number | undefined;
            if (
                walletIndex !== -1 &&
                accountPreBalances[walletIndex] !== undefined &&
                accountPostBalances[walletIndex] !== undefined
            ) {
                solChange = Math.abs(accountPostBalances[walletIndex] - accountPreBalances[walletIndex]) / LAMPORTS_PER_SOL;
            }

            if (solChange === undefined || tokenAmount === undefined) return null;

            const swapData: PumpSwapData = {
                swapType: SwapType.PUMP,
                tokenAddress: mint,
                bondingCurve,
                associatedBondingCurve,
                virtualTokenReserves: '',
                virtualSolReserves: '',
                walletAddress,
                isBuy,
                success: tx.transaction.meta?.err == null,
                userTokenAccount,
                amountIn: isBuy ? solChange : tokenAmount,
                amountOut: isBuy ? tokenAmount : solChange,
                decimalsIn: isBuy ? 9 : 6,
                decimalsOut: isBuy ? 6 : 9,
                signature: tx.transaction.signature instanceof Uint8Array
                    ? bs58.encode(tx.transaction.signature)
                    : tx.transaction.signature,
                timestamp: new Date()
            };

            return swapData;

        } catch (error) {
            console.error(chalk.hex(COLORS.ERROR)('Error extracting pump.fun swap details:'), error);
            return null;
        }
    }

    // -------------------------------------------------------------------------
    // RAYDIUM DETECTION & DETAILS
    // -------------------------------------------------------------------------
    private extractRaydiumPoolAccounts(tx: any): RaydiumSwapData | null {
        try {
            const accounts = tx.transaction?.transaction?.message?.accountKeys;
            if (!accounts || !Array.isArray(accounts)) return null;

            const instructions = tx.transaction?.transaction?.message?.instructions;
            const raydiumInstruction = instructions?.find((ix: any) => {
                const programId = accounts[ix.programIdIndex];
                return (
                    (programId instanceof Uint8Array || programId?.type === 'Buffer') &&
                    new PublicKey(programId).equals(RAYDIUM_AMM_PROGRAM_ID)
                );
            });
            
            if (!raydiumInstruction) return null;

            const getAccountFromIndex = (index: number): PublicKey => {
                const account = accounts[index];
                if (account instanceof Uint8Array) {
                    return new PublicKey(account);
                } else if (account?.type === 'Buffer') {
                    return new PublicKey(Buffer.from(account.data));
                }
                throw new Error(`Invalid account at index ${index}`);
            };

            const keys = raydiumInstruction.accounts;
            const poolCoinTokenAccount = getAccountFromIndex(keys[5]);
            const tokenAddress = poolCoinTokenAccount;

            const poolAccounts: RaydiumSwapData = {
                swapType: SwapType.RAYDIUM,
                tokenAddress,
                ammId: getAccountFromIndex(keys[1]),
                ammAuthority: getAccountFromIndex(keys[2]),
                ammOpenOrders: getAccountFromIndex(keys[3]),
                ammTargetOrders: getAccountFromIndex(keys[4]),
                poolCoinTokenAccount,
                poolPcTokenAccount: getAccountFromIndex(keys[6]),
                poolLpTokenAccount: getAccountFromIndex(keys[15]),
                poolTempLpTokenAccount: getAccountFromIndex(keys[16]),
                serumProgramId: getAccountFromIndex(keys[7]),
                serumMarket: getAccountFromIndex(keys[8]),
                serumBids: getAccountFromIndex(keys[9]),
                serumAsks: getAccountFromIndex(keys[10]),
                serumEventQueue: getAccountFromIndex(keys[11]),
                serumBaseVault: getAccountFromIndex(keys[12]),
                serumQuoteVault: getAccountFromIndex(keys[13]),
                serumOpenOrders: getAccountFromIndex(keys[14])
            };

            return poolAccounts;

        } catch (error) {
            console.error(chalk.hex(COLORS.ERROR)('Error extracting pool accounts:'), error);
            return null;
        }
    }

    private async extractSwapDetails(
        tx: any,
        walletAddress: string,
        poolAccounts: RaydiumSwapData,
        preBalances: TokenBalance[],
        postBalances: TokenBalance[]
    ) {
        try {
            const userAccounts = preBalances.filter(balance => balance.owner === walletAddress);
            const accountBalances = new Map<string, {
                exists: boolean;
                isATA: boolean;
                preBalance: number;
                postBalance: number;
                decimals: number;
                mint: string;
            }>();

            for (const preBalance of userAccounts) {
                const postBalance = postBalances.find(p => p.accountIndex === preBalance.accountIndex);
                accountBalances.set(preBalance.accountIndex.toString(), {
                    exists: true,
                    isATA: true,
                    preBalance: Number(preBalance.uiTokenAmount.uiAmount || 0),
                    postBalance: postBalance ? Number(postBalance.uiTokenAmount.uiAmount || 0) : 0,
                    decimals: preBalance.uiTokenAmount.decimals,
                    mint: preBalance.mint
                });
            }

            const poolBalances = {
                coin: { pre: 0, post: 0, decimals: 0 },
                pc: { pre: 0, post: 0, decimals: 0 }
            };

            const accounts = tx.transaction?.transaction?.message?.accountKeys;
            const instructions = tx.transaction?.transaction?.message?.instructions;
            const raydiumInstruction = instructions?.find((ix: any) => {
                const programId = accounts[ix.programIdIndex];
                return (
                    (programId instanceof Uint8Array || programId?.type === 'Buffer') &&
                    new PublicKey(programId).equals(RAYDIUM_AMM_PROGRAM_ID)
                );
            });

            if (raydiumInstruction) {
                const poolCoinIndex = raydiumInstruction.accounts[5];
                const poolPcIndex = raydiumInstruction.accounts[6];

                const coinPreBalance = preBalances.find(b => b.accountIndex === poolCoinIndex);
                const coinPostBalance = postBalances.find(b => b.accountIndex === poolCoinIndex);
                const pcPreBalance = preBalances.find(b => b.accountIndex === poolPcIndex);
                const pcPostBalance = postBalances.find(b => b.accountIndex === poolPcIndex);

                if (coinPreBalance) {
                    poolBalances.coin = {
                        pre: Number(coinPreBalance.uiTokenAmount.uiAmount || 0),
                        post: coinPostBalance ? Number(coinPostBalance.uiTokenAmount.uiAmount || 0) : 0,
                        decimals: coinPreBalance.uiTokenAmount.decimals
                    };
                }
                if (pcPreBalance) {
                    poolBalances.pc = {
                        pre: Number(pcPreBalance.uiTokenAmount.uiAmount || 0),
                        post: pcPostBalance ? Number(pcPostBalance.uiTokenAmount.uiAmount || 0) : 0,
                        decimals: pcPreBalance.uiTokenAmount.decimals
                    };
                }
            }

            return {
                userAccounts: accountBalances,
                poolBalances,
                signature: tx.transaction.signature,
                slot: tx.slot,
                accountExists: {
                    hasSourceAccount: accountBalances.has(poolAccounts.poolCoinTokenAccount.toString()),
                    hasDestAccount: accountBalances.has(poolAccounts.poolPcTokenAccount.toString())
                }
            };

        } catch (error) {
            console.error(chalk.hex(COLORS.ERROR)('Error extracting swap details:'), error);
            return null;
        }
    }

    // -------------------------------------------------------------------------
    // TOKEN CHANGES
    // -------------------------------------------------------------------------
    private calculateTokenChanges(
        preBalances: TokenBalance[],
        postBalances: TokenBalance[]
    ) {
        try {
            const changes = new Map<
                string,
                { totalChange: number; decimals: number; preAmount: number; postAmount: number }
            >();

            for (const post of postBalances) {
                const pre = preBalances.find(p => p.accountIndex === post.accountIndex);
                if (!pre || pre.mint !== post.mint) continue;

                const preAmount = Number(pre.uiTokenAmount.uiAmount || 0);
                const postAmount = Number(post.uiTokenAmount.uiAmount || 0);
                const change = postAmount - preAmount;

                changes.set(post.mint, {
                    totalChange: change,
                    decimals: post.uiTokenAmount.decimals,
                    preAmount,
                    postAmount
                });
            }

            const tokenEntry = Array.from(changes.entries()).find(([mint]) => mint !== NATIVE_MINT.toString());
            if (!tokenEntry) return null;

            const [mint, data] = tokenEntry;
            const tokenMint = new PublicKey(mint);

            const wsol = changes.get(NATIVE_MINT.toString());
            const token = changes.get(mint);

            const isBuy = (wsol?.totalChange || 0) < 0 && (token?.totalChange || 0) > 0;

            const tokenChange = Math.abs(token?.totalChange || 0);
            const wsolChange = Math.abs(wsol?.totalChange || 0);

            return {
                tokenMint,
                tokenIn: isBuy ? NATIVE_MINT.toString() : mint,
                tokenOut: isBuy ? mint : NATIVE_MINT.toString(),
                amountIn: isBuy ? wsolChange : tokenChange,
                amountOut: isBuy ? tokenChange : wsolChange,
                decimalsIn: isBuy ? wsol?.decimals : token?.decimals,
                decimalsOut: isBuy ? token?.decimals : wsol?.decimals
            };

        } catch (error) {
            console.error(chalk.hex(COLORS.ERROR)('Error calculating token changes:'), error);
            return null;
        }
    }

    // -------------------------------------------------------------------------
    // DETECT RAYDIUM SWAP DIRECTION
    // -------------------------------------------------------------------------
    private detectSwapDirection(
        preBalances: TokenBalance[],
        postBalances: TokenBalance[],
        poolBalances: {
            coin: { pre: number; post: number; decimals: number };
            pc: { pre: number; post: number; decimals: number };
        }
    ): 'buy' | 'sell' {
        const coinChange = poolBalances.coin.post - poolBalances.coin.pre;
        const pcChange = poolBalances.pc.post - poolBalances.pc.pre;

        if (coinChange < 0 && pcChange > 0) return 'sell';
        if (coinChange > 0 && pcChange < 0) return 'buy';

        const wsolChanges = this.calculateTokenChange(preBalances, postBalances, NATIVE_MINT.toString());
        return wsolChanges < 0 ? 'buy' : 'sell';
    }

    private calculateTokenChange(
        preBalances: TokenBalance[],
        postBalances: TokenBalance[],
        mintAddress: string
    ): number {
        const pre = preBalances
            .filter(b => b.mint === mintAddress)
            .reduce((sum, b) => sum + Number(b.uiTokenAmount.uiAmount || 0), 0);
        const post = postBalances
            .filter(b => b.mint === mintAddress)
            .reduce((sum, b) => sum + Number(b.uiTokenAmount.uiAmount || 0), 0);
        return post - pre;
    }

    // -------------------------------------------------------------------------
    // UTILITIES
    // -------------------------------------------------------------------------
    public getStatus(): MonitorStatus {
        return { ...this.status };
    }

    private async extractWalletAddress(tx: any): Promise<string | undefined> {
        try {
            const accountKeys = tx.transaction?.transaction?.message?.accountKeys;
            if (!accountKeys || !Array.isArray(accountKeys) || accountKeys.length === 0) {
                return undefined;
            }
            const firstKey = accountKeys[0];
            if (firstKey instanceof Uint8Array) {
                return bs58.encode(firstKey);
            } else if (firstKey.type === 'Buffer' && Array.isArray(firstKey.data)) {
                return bs58.encode(Buffer.from(firstKey.data));
            }
            return undefined;
        } catch (error) {
            console.error(chalk.hex(COLORS.ERROR)('Error extracting wallet address:'), error);
            return undefined;
        }
    }

    public addWallet(address: string): void {
        if (!address.match(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/)) {
            throw new Error(chalk.hex(COLORS.ERROR)(`Invalid wallet address: ${address}`));
        }
        if (!this.config.wallets.includes(address)) {
            this.config.wallets.push(address);
            this.walletSet.add(address);
            if (this.status.isActive) {
                console.log(chalk.hex(COLORS.PRIMARY)('Restarting monitor to include new wallet...'));
                this.stop().then(() => this.start());
            }
        }
    }

    public removeWallet(address: string): void {
        const index = this.config.wallets.indexOf(address);
        if (index !== -1) {
            this.config.wallets.splice(index, 1);
            this.walletSet.delete(address);
            if (this.status.isActive) {
                console.log(chalk.hex(COLORS.PRIMARY)('Restarting monitor after wallet removal...'));
                this.stop().then(() => this.start());
            }
        }
    }
}
