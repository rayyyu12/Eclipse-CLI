// src/cli/handlers/copyTradeHandler.ts

import chalk from 'chalk';
import { rl } from '../utils/formatting';
import { TransactionMonitor } from '../../copytrading/handlers/transactionMonitor';
import { CredentialsManager } from '../utils/credentialsManager';
import { WalletStorage } from '../utils/walletStorage';
import { ParsedSwapData } from '../../copytrading/types/types';
import { BalanceMonitor } from '../../copytrading/handlers/balanceUpdater';
import { CommitmentLevel } from '@triton-one/yellowstone-grpc';
import { BlockhashManager } from '../../utils/swaps/blockhashManager';
import { handleCopyTradeSettings } from './copyTradeSettingsHandler';

let activeMonitor: TransactionMonitor | null = null;
const walletStorage = WalletStorage.getInstance();

export async function handleCopyTrade(): Promise<void> {
    while (true) {
        console.clear();
        const header = "Copy Trading Menu";
        const divider = "—".repeat(30);
        
        console.log(chalk.cyan.bold(`\n${header}`));
        console.log(chalk.gray(divider));

        // Show current status
        if (activeMonitor?.getStatus().isActive) {
            const status = activeMonitor.getStatus();
            console.log(chalk.green("Monitor Status: ACTIVE"));
            console.log(chalk.white(`Transactions Processed: ${status.processedTransactions}`));
            console.log(chalk.white(`Swaps Detected: ${status.detectedSwaps}`));
            if (status.lastTransactionAt) {
                console.log(chalk.white(`Last Activity: ${status.lastTransactionAt.toLocaleString()}`));
            }

            // Add balance monitor status
            try {
                const balanceMonitor = BalanceMonitor.getInstance();
                if (balanceMonitor.getStatus().isActive) {
                    console.log(chalk.cyan("\nWallet Balances:"));
                    console.log(chalk.white(`SOL Balance: ${balanceMonitor.getCurrentBalance().toFixed(9)}`));
                    const status = balanceMonitor.getStatus();
                    if (status.lastUpdateTime) {  // Check if lastUpdateTime exists
                        console.log(chalk.gray(`Last Update: ${status.lastUpdateTime.toLocaleString()}`));
                    }
                }
            } catch {
                // Balance monitor might not be initialized yet
            }
        } else {
            console.log(chalk.yellow("Monitor Status: INACTIVE"));
        }

        // Show monitored wallets
        const monitoredWallets = walletStorage.getWallets();
        if (monitoredWallets.size > 0) {
            console.log(chalk.cyan("\nMonitored Wallets:"));
            for (const wallet of monitoredWallets) {
                console.log(chalk.white(`  ${wallet}`));
            }
        } else {
            console.log(chalk.yellow("\nNo wallets currently monitored"));
        }

        console.log(chalk.white("1. Start Monitoring"));
        console.log(chalk.white("2. Stop Monitoring"));
        console.log(chalk.white("3. Add Wallet to Monitor"));
        console.log(chalk.white("4. Remove Wallet"));
        console.log(chalk.white("5. Copy Trade Settings")); // New option
        console.log(chalk.white("6. Back to Main Menu"));
        
        const choice = await new Promise<string>(resolve => {
            rl.question(chalk.cyan('\nSelect an option: '), resolve);
        });

        switch (choice) {
            case "1":
                await startMonitoring();
                break;
            case "2":
                await stopMonitoring();
                break;
            case "3":
                await addWallet();
                break;
            case "4":
                await removeWallet();
                break;
            case "5":
                await handleCopyTradeSettings(); // New handler
                break;
            case "6":
                return;
            default:
                console.log(chalk.red("Invalid option"));
        }

        if (choice !== "5") {
            await new Promise<void>(resolve => {
                rl.question(chalk.gray('\nPress Enter to continue...'), () => resolve());
            });
        }
    }
}

async function startMonitoring(): Promise<void> {
    if (activeMonitor?.getStatus().isActive) {
        console.log(chalk.yellow("Monitor is already running!"));
        return;
    }

    const monitoredWallets = walletStorage.getWallets();
    if (monitoredWallets.size === 0) {
        console.log(chalk.yellow("Please add at least one wallet to monitor first!"));
        return;
    }

    const credManager = CredentialsManager.getInstance();
    if (!credManager.hasBasicCredentials()) {
        console.log(chalk.red("Please configure RPC settings in the Settings menu first!"));
        return;
    }

    try {
        let grpcUrl: string;
        let rpcUrl: string;
        try {
            grpcUrl = credManager.getGrpcUrl();
            rpcUrl = credManager.getRpcUrl();
        } catch {
            grpcUrl = credManager.getRpcUrl();
            rpcUrl = credManager.getRpcUrl();
        }

        // Initialize BlockhashManager with the connection
        const connection = credManager.getConnection();
        BlockhashManager.getInstance().initialize(connection);
        console.log(chalk.green("Blockhash manager initialized"));

        // Get optional auth token
        let authToken: string | undefined;
        try {
            authToken = credManager.getAuthToken();
        } catch {
            // Auth token is optional
        }

        // Initialize balance monitor for each wallet
        for (const wallet of monitoredWallets) {
            try {
                await BalanceMonitor.initialize({
                    grpcEndpoint: grpcUrl,  // For gRPC subscription
                    rpcEndpoint: rpcUrl,    // For RPC balance check
                    xToken: authToken,
                    wallet,
                    commitment: CommitmentLevel.PROCESSED
                });

                const balanceMonitor = BalanceMonitor.getInstance();
                balanceMonitor.on('balanceChange', (event) => {
                    console.log(chalk.cyan('\nBalance Update:'));
                    console.log(chalk.white(`Wallet: ${wallet}`));
                    console.log(chalk.white(`Old Balance: ${event.oldBalance.toFixed(9)} SOL`));
                    console.log(chalk.white(`New Balance: ${event.newBalance.toFixed(9)} SOL`));
                    console.log(chalk.white(`Change: ${event.change.toFixed(9)} SOL`));
                    console.log(chalk.gray(`Slot: ${event.slot}`));
                });

                balanceMonitor.on('error', (error) => {
                    console.log(chalk.red(`\nBalance Monitor Error: ${error.message}`));
                });

                console.log(chalk.green(`Balance monitor initialized for wallet: ${wallet}`));
                console.log(chalk.white(`Initial balance: ${balanceMonitor.getCurrentBalance().toFixed(9)} SOL`));
            } catch (error) {
                console.error(chalk.red(`Failed to initialize balance monitor for wallet ${wallet}:`), error);
            }
        }

        // Initialize transaction monitor
        activeMonitor = new TransactionMonitor({
            grpcEndpoint: grpcUrl,
            xToken: authToken,
            wallets: Array.from(monitoredWallets),
            enablePump: true,
            enableRaydium: true
        });

        activeMonitor.on('swap', (swapData: ParsedSwapData) => {
            console.log(chalk.green('\nSwap Detected!'));
            console.log(chalk.white(`Type: ${swapData.swapType}`));
            console.log(chalk.white(`Token: ${swapData.tokenAddress.toString()}`));
            if (swapData.amountIn) {
                console.log(chalk.white(`Amount: ${swapData.amountIn} lamports`));
            }
        });

        activeMonitor.on('error', (error) => {
            console.log(chalk.red(`\nTransaction Monitor Error: ${error.message}`));
        });

        await activeMonitor.start();
        console.log(chalk.green("\nAll monitors started successfully!"));

    } catch (error) {
        console.error(chalk.red("Failed to start monitors:"), error);
    }
}

async function stopMonitoring(): Promise<void> {
    if (!activeMonitor?.getStatus().isActive) {
        console.log(chalk.yellow("Monitor is not running!"));
        return;
    }

    try {
        await activeMonitor.stop();
        console.log(chalk.green("Monitor stopped successfully!"));
    } catch (error) {
        console.error(chalk.red("Failed to stop monitor:"), error);
    }
}

async function addWallet(): Promise<void> {
    const walletAddress = await new Promise<string>(resolve => {
        rl.question(chalk.cyan('Enter wallet address to monitor: '), resolve);
    });

    try {
        if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(walletAddress)) {
            throw new Error("Invalid Solana wallet address format");
        }

        walletStorage.addWallet(walletAddress);
        
        if (activeMonitor?.getStatus().isActive) {
            activeMonitor.addWallet(walletAddress);
        }

        console.log(chalk.green(`Added wallet: ${walletAddress}`));
    } catch (error) {
        console.error(chalk.red("Failed to add wallet:"), error);
    }
}

async function removeWallet(): Promise<void> {
    const monitoredWallets = walletStorage.getWallets();
    if (monitoredWallets.size === 0) {
        console.log(chalk.yellow("No wallets to remove!"));
        return;
    }

    const walletAddress = await new Promise<string>(resolve => {
        rl.question(chalk.cyan('Enter wallet address to remove: '), resolve);
    });

    if (monitoredWallets.has(walletAddress)) {
        walletStorage.removeWallet(walletAddress);
        if (activeMonitor?.getStatus().isActive) {
            activeMonitor.removeWallet(walletAddress);
        }
        console.log(chalk.green(`Removed wallet: ${walletAddress}`));
    } else {
        console.log(chalk.yellow("Wallet not found in monitored list!"));
    }
}