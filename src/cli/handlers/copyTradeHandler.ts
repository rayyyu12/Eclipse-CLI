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
import { CopyTradeLogger } from '../utils/copyTradeLogger';
import { COLORS } from '../config';
import { PortfolioTracker } from '../../utils/positions/portfolioTracker';
import { TokenBalanceMonitor } from '../../utils/positions/tokenBalanceMonitor';
import { Logger } from '../utils/logger';

let activeMonitor: TransactionMonitor | null = null;
const walletStorage = WalletStorage.getInstance();
const logger = CopyTradeLogger.getInstance();
const systemLogger = Logger.getInstance();

export async function handleCopyTrade(): Promise<void> {
    while (true) {
        console.clear();
        const header = "Copy Trading Menu";
        const divider = "—".repeat(30);
        
        console.log(chalk.hex(COLORS.PRIMARY)(`\n${header}`));
        console.log(chalk.hex(COLORS.SECONDARY)(divider));

        // Show current status - with error handling
        try {
            if (activeMonitor?.getStatus().isActive) {
                const status = activeMonitor.getStatus();
                console.log(chalk.hex(COLORS.PRIMARY)("Monitor Status: ACTIVE"));
                console.log(chalk.hex(COLORS.ACCENT)(`Transactions Processed: ${status.processedTransactions}`));
                console.log(chalk.hex(COLORS.ACCENT)(`Swaps Detected: ${status.detectedSwaps}`));
                if (status.lastTransactionAt) {
                    console.log(chalk.hex(COLORS.ACCENT)(`Last Activity: ${status.lastTransactionAt.toLocaleString()}`));
                }

                // Add balance monitor status - with error handling
                try {
                    const balanceMonitor = BalanceMonitor.getInstance();
                    if (balanceMonitor.getStatus().isActive) {
                        console.log(chalk.hex(COLORS.PRIMARY)("\nWallet Balances:"));
                        console.log(chalk.hex(COLORS.ACCENT)(`SOL Balance: ${balanceMonitor.getCurrentBalance().toFixed(9)}`));
                        const status = balanceMonitor.getStatus();
                        if (status.lastUpdateTime) {
                            console.log(chalk.hex(COLORS.SECONDARY)(`Last Update: ${status.lastUpdateTime.toLocaleString()}`));
                        }
                    }
                } catch (error) {
                    console.log(chalk.hex(COLORS.ERROR)("Balance Monitor: ERROR"));
                    console.log(chalk.hex(COLORS.SECONDARY)(`Error: ${error instanceof Error ? error.message : String(error)}`));
                }
            } else {
                console.log(chalk.hex(COLORS.ERROR)("Monitor Status: INACTIVE"));
            }
        } catch (error) {
            console.log(chalk.hex(COLORS.ERROR)("Monitor Status: ERROR"));
            console.log(chalk.hex(COLORS.SECONDARY)(`Error: ${error instanceof Error ? error.message : String(error)}`));
        }

        // Show portfolio status - with error handling
        try {
            const portfolioTracker = PortfolioTracker.getInstance();
            const positions = await portfolioTracker.getAllPositions().catch(err => {
                console.log(chalk.hex(COLORS.ERROR)("Error fetching portfolio: " + (err instanceof Error ? err.message : String(err))));
                return { positions: [], totalValue: 0, totalPnl: 0, totalPnlPercentage: 0, lastUpdated: 0 };
            });
            console.log(chalk.hex(COLORS.PRIMARY)("\nPortfolio Status:"));
            console.log(chalk.hex(COLORS.ACCENT)(`Tracked Positions: ${positions.positions.length}`));
            console.log(chalk.hex(COLORS.ACCENT)(`Total Value: ${positions.totalValue.toFixed(6)} SOL`));
            console.log(chalk.hex(COLORS.ACCENT)(`Total PnL: ${positions.totalPnlPercentage.toFixed(2)}%`));
        } catch (error) {
            console.log(chalk.hex(COLORS.ERROR)("\nPortfolio: ERROR"));
            console.log(chalk.hex(COLORS.SECONDARY)(`Error: ${error instanceof Error ? error.message : String(error)}`));
        }

        // Show monitored wallets - with error handling
        try {
            const monitoredWallets = walletStorage.getWallets();
            if (monitoredWallets.size > 0) {
                console.log(chalk.hex(COLORS.PRIMARY)("\nMonitored Wallets:"));
                for (const wallet of monitoredWallets) {
                    console.log(chalk.hex(COLORS.ACCENT)(`  ${wallet}`));
                }
            } else {
                console.log(chalk.yellow("\nNo wallets currently monitored"));
            }
        } catch (error) {
            console.log(chalk.hex(COLORS.ERROR)("\nWallet Storage: ERROR"));
            console.log(chalk.hex(COLORS.SECONDARY)(`Error: ${error instanceof Error ? error.message : String(error)}`));
        }

        console.log(chalk.hex(COLORS.ACCENT)("1. Start Monitoring"));
        console.log(chalk.hex(COLORS.ACCENT)("2. Stop Monitoring"));
        console.log(chalk.hex(COLORS.ACCENT)("3. Add Wallet to Monitor"));
        console.log(chalk.hex(COLORS.ACCENT)("4. Remove Wallet"));
        console.log(chalk.hex(COLORS.ACCENT)("5. Copy Trade Settings"));
        console.log(chalk.hex(COLORS.ACCENT)("6. View Logs"));
        console.log(chalk.hex(COLORS.ACCENT)("7. Export Portfolio"));
        console.log(chalk.hex(COLORS.ACCENT)("8. Back to Main Menu"));
        
        const choice = await new Promise<string>(resolve => {
            rl.question(chalk.hex(COLORS.PRIMARY)('\nSelect an option: '), resolve);
        });

        let shouldPromptForContinue = true;

        try {
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
                    await handleCopyTradeSettings();
                    shouldPromptForContinue = false;
                    break;
                case "6":
                    await viewLogs();
                    shouldPromptForContinue = false;
                    break;
                case "7":
                    await exportPortfolio();
                    shouldPromptForContinue = false;
                    break;
                case "8":
                    await cleanupBeforeExit();
                    return;
                default:
                    console.log(chalk.hex(COLORS.ERROR)("Invalid option"));
            }
        } catch (error) {
            systemLogger.error('CopyTradeHandler', `Error handling option ${choice}`, error);
            console.log(chalk.hex(COLORS.ERROR)(`\nError: ${error instanceof Error ? error.message : String(error)}`));
        }

        if (shouldPromptForContinue) {
            await new Promise<void>(resolve => {
                rl.question(chalk.hex(COLORS.SECONDARY)('\nPress Enter to continue...'), () => resolve());
            });
        }
    }
}

async function exportPortfolio(): Promise<void> {
    try {
        console.log(chalk.hex(COLORS.PRIMARY)("\nExporting Portfolio to Discord..."));
        
        const portfolioTracker = PortfolioTracker.getInstance();
        await portfolioTracker.exportPortfolioToDiscord().catch(err => {
            throw new Error(`Export failed: ${err instanceof Error ? err.message : String(err)}`);
        });
        
        console.log(chalk.hex(COLORS.SUCCESS)("\nPortfolio exported successfully!"));
    } catch (error) {
        systemLogger.error('CopyTradeHandler', 'Failed to export portfolio', error);
        console.error(chalk.hex(COLORS.ERROR)("\nFailed to export portfolio:"), error);
    }
    
    await new Promise<void>(resolve => {
        rl.question(chalk.hex(COLORS.SECONDARY)('\nPress Enter to continue...'), () => resolve());
    });
}

async function viewLogs(): Promise<void> {
    console.clear();
    console.log(chalk.hex(COLORS.PRIMARY)("\nCopy Trade Logs"));
    console.log(chalk.hex(COLORS.SECONDARY)("—".repeat(30)));

    const displayLogs = () => {
        console.clear();
        console.log(chalk.hex(COLORS.PRIMARY)("\nCopy Trade Logs"));
        console.log(chalk.hex(COLORS.SECONDARY)("—".repeat(30)));
        
        const logs = logger.getLogs(50); // Get last 50 logs
        if (logs.length === 0) {
            console.log(chalk.yellow("\nNo logs available"));
        } else {
            logs.forEach(log => {
                try {
                    console.log(logger.formatLog(log));
                } catch (error) {
                    console.log(chalk.hex(COLORS.ERROR)(`Error formatting log: ${error instanceof Error ? error.message : String(error)}`));
                }
            });
        }

        console.log(chalk.hex(COLORS.ACCENT)("\n1. Stop Auto-Update"));
        console.log(chalk.hex(COLORS.ACCENT)("2. Clear Logs"));
        console.log(chalk.hex(COLORS.ACCENT)("3. Back to Copy Trading Menu"));
    };

    // Set up event listeners for auto-updating
    const handleNewLog = () => {
        try {
            displayLogs();
        } catch (error) {
            console.error("Error updating logs display:", error instanceof Error ? error.message : String(error));
        }
    };

    const handleLogsCleared = () => {
        try {
            displayLogs();
        } catch (error) {
            console.error("Error refreshing logs after clear:", error instanceof Error ? error.message : String(error));
        }
    };

    try {
        logger.on('newLog', handleNewLog);
        logger.on('logsCleared', handleLogsCleared);

        // Initial display
        displayLogs();

        while (true) {
            const choice = await new Promise<string>(resolve => {
                rl.question(chalk.hex(COLORS.PRIMARY)('\nSelect an option: '), resolve);
            });

            switch (choice) {
                case "1":
                    // Remove event listeners and return to manual refresh mode
                    logger.removeListener('newLog', handleNewLog);
                    logger.removeListener('logsCleared', handleLogsCleared);
                    return;
                case "2":
                    try {
                        logger.clearLogs();
                    } catch (error) {
                        console.error("Error clearing logs:", error instanceof Error ? error.message : String(error));
                    }
                    break;
                case "3":
                    // Clean up event listeners before returning
                    logger.removeListener('newLog', handleNewLog);
                    logger.removeListener('logsCleared', handleLogsCleared);
                    return;
                default:
                    console.log(chalk.hex(COLORS.ERROR)("Invalid option"));
                    await new Promise<void>(resolve => {
                        rl.question(chalk.hex(COLORS.SECONDARY)('\nPress Enter to continue...'), () => resolve());
                    });
            }
        }
    } catch (error) {
        // Handle any errors in the log viewer
        systemLogger.error('CopyTradeHandler', 'Error in log viewer', error);
        console.error(chalk.hex(COLORS.ERROR)("Error in log viewer:"), error instanceof Error ? error.message : String(error));
        
        // Clean up event listeners
        logger.removeListener('newLog', handleNewLog);
        logger.removeListener('logsCleared', handleLogsCleared);
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
        console.log(chalk.hex(COLORS.ERROR)("Please configure RPC settings in the Settings menu first!"));
        return;
    }

    try {
        // Initialize portfolio tracking first - with error handling
        console.log(chalk.hex(COLORS.PRIMARY)("Initializing portfolio tracking..."));
        
        try {
            const portfolioTracker = PortfolioTracker.getInstance();
            await portfolioTracker.initializeBalanceMonitoring()
                .catch(error => {
                    systemLogger.warn('CopyTradeHandler', 'Portfolio tracking initialization failed', error);
                    console.log(chalk.hex(COLORS.SECONDARY)('Portfolio initialization error, continuing with monitor setup'));
                });
        } catch (error) {
            systemLogger.warn('CopyTradeHandler', 'Portfolio tracking initialization failed', error);
            console.log(chalk.hex(COLORS.SECONDARY)('Portfolio initialization error, continuing with monitor setup'));
        }
        
        // Get URLs - with error handling and fallbacks
        let grpcUrl: string;
        let rpcUrl: string;
        
        try {
            grpcUrl = credManager.getGrpcUrl();
            rpcUrl = credManager.getRpcUrl();
        } catch {
            // Fallback: use RPC URL for both if GRPC fails
            try {
                rpcUrl = credManager.getRpcUrl();
                grpcUrl = rpcUrl;
                console.log(chalk.hex(COLORS.SECONDARY)("GRPC URL not found, using RPC URL as fallback"));
            } catch (error) {
                systemLogger.error('CopyTradeHandler', 'Failed to get URLS', error);
                throw new Error("Failed to get required URLs. Please check your settings.");
            }
        }

        // Initialize BlockhashManager - with error handling
        try {
            const connection = credManager.getConnection();
            BlockhashManager.getInstance().initialize(connection);
        } catch (error) {
            systemLogger.warn('CopyTradeHandler', 'BlockhashManager initialization failed', error);
            console.log(chalk.hex(COLORS.SECONDARY)("BlockhashManager initialization failed, some features may be limited"));
        }

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
                }).catch(error => {
                    systemLogger.warn('CopyTradeHandler', `Failed to initialize balance monitor for ${wallet}`, error);
                    console.log(chalk.hex(COLORS.SECONDARY)(`Balance monitor setup failed for ${wallet}, continuing...`));
                });

                const balanceMonitor = BalanceMonitor.getInstance();

                balanceMonitor.on('error', (error) => {
                    systemLogger.warn('BalanceMonitor', 'Error event received', error);
                    console.log(chalk.hex(COLORS.ERROR)(`\nBalance Monitor Error: ${error instanceof Error ? error.message : String(error)}`));
                });

            } catch (error) {
                systemLogger.error('CopyTradeHandler', `Failed to initialize balance monitor for ${wallet}`, error);
                console.log(chalk.hex(COLORS.ERROR)(`Failed to initialize balance monitor for wallet ${wallet}:`), error instanceof Error ? error.message : String(error));
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
            console.log(chalk.hex(COLORS.SUCCESS)('\nSwap Detected!'));
            console.log(chalk.hex(COLORS.ACCENT)(`Type: ${swapData.swapType}`));
            console.log(chalk.hex(COLORS.ACCENT)(`Token: ${swapData.tokenAddress.toString()}`));
            if (swapData.amountIn) {
                console.log(chalk.hex(COLORS.ACCENT)(`Amount: ${swapData.amountIn} lamports`));
            }
        });

        activeMonitor.on('error', (error) => {
            systemLogger.warn('TransactionMonitor', 'Error event received', error);
            console.log(chalk.hex(COLORS.ERROR)(`\nTransaction Monitor Error: ${error instanceof Error ? error.message : String(error)}`));
        });

        await activeMonitor.start().catch(error => {
            systemLogger.error('CopyTradeHandler', 'Failed to start monitor', error);
            throw new Error(`Failed to start monitor: ${error instanceof Error ? error.message : String(error)}`);
        });
        
        console.log(chalk.hex(COLORS.SUCCESS)("\nMonitor started successfully!"));

    } catch (error) {
        systemLogger.error('CopyTradeHandler', 'Failed to start monitors', error);
        console.error(chalk.hex(COLORS.ERROR)("Failed to start monitors:"), error instanceof Error ? error.message : String(error));
        
        // Make sure activeMonitor is null if starting it failed
        activeMonitor = null;
    }
}

async function stopMonitoring(): Promise<void> {
    if (!activeMonitor?.getStatus().isActive) {
        console.log(chalk.yellow("Monitor is not running!"));
        return;
    }

    try {
        await activeMonitor.stop();
        console.log(chalk.hex(COLORS.SUCCESS)("Monitor stopped successfully!"));
    } catch (error) {
        systemLogger.error('CopyTradeHandler', 'Failed to stop monitor', error);
        console.error(chalk.hex(COLORS.ERROR)("Failed to stop monitor:"), error instanceof Error ? error.message : String(error));
    }
}

async function addWallet(): Promise<void> {
    const walletAddress = await new Promise<string>(resolve => {
        rl.question(chalk.hex(COLORS.PRIMARY)('Enter wallet address to monitor: '), resolve);
    });

    try {
        if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(walletAddress)) {
            throw new Error("Invalid Solana wallet address format");
        }

        walletStorage.addWallet(walletAddress);
        
        if (activeMonitor?.getStatus().isActive) {
            try {
                activeMonitor.addWallet(walletAddress);
            } catch (error) {
                systemLogger.warn('CopyTradeHandler', `Failed to add wallet to active monitor: ${walletAddress}`, error);
                console.log(chalk.hex(COLORS.SECONDARY)("Wallet added to storage but not to active monitor. You may need to restart monitoring."));
            }
        }

        console.log(chalk.hex(COLORS.SUCCESS)(`Added wallet: ${walletAddress}`));
    } catch (error) {
        systemLogger.error('CopyTradeHandler', `Failed to add wallet: ${walletAddress}`, error);
        console.error(chalk.hex(COLORS.ERROR)("Failed to add wallet:"), error instanceof Error ? error.message : String(error));
    }
}

async function removeWallet(): Promise<void> {
    try {
        const monitoredWallets = walletStorage.getWallets();
        if (monitoredWallets.size === 0) {
            console.log(chalk.yellow("No wallets to remove!"));
            return;
        }

        const walletAddress = await new Promise<string>(resolve => {
            rl.question(chalk.hex(COLORS.PRIMARY)('Enter wallet address to remove: '), resolve);
        });

        if (monitoredWallets.has(walletAddress)) {
            walletStorage.removeWallet(walletAddress);
            
            if (activeMonitor?.getStatus().isActive) {
                try {
                    activeMonitor.removeWallet(walletAddress);
                } catch (error) {
                    systemLogger.warn('CopyTradeHandler', `Failed to remove wallet from active monitor: ${walletAddress}`, error);
                    console.log(chalk.hex(COLORS.SECONDARY)("Wallet removed from storage but not from active monitor. You may need to restart monitoring."));
                }
            }
            
            console.log(chalk.hex(COLORS.SUCCESS)(`Removed wallet: ${walletAddress}`));
        } else {
            console.log(chalk.yellow("Wallet not found in monitored list!"));
        }
    } catch (error) {
        systemLogger.error('CopyTradeHandler', 'Failed to remove wallet', error);
        console.error(chalk.hex(COLORS.ERROR)("Failed to remove wallet:"), error instanceof Error ? error.message : String(error));
    }
}

async function cleanupBeforeExit(): Promise<void> {
    try {
        // Stop any active monitoring
        if (activeMonitor?.getStatus().isActive) {
            try {
                await activeMonitor.stop();
            } catch (error) {
                systemLogger.error('CopyTradeHandler', 'Error stopping active monitor during cleanup', error);
                console.log(chalk.hex(COLORS.ERROR)("Error stopping monitor:"), error instanceof Error ? error.message : String(error));
            }
        }
        
        // Clean up portfolio tracker
        try {
            await PortfolioTracker.getInstance().cleanup();
        } catch (error) {
            systemLogger.error('CopyTradeHandler', 'Error cleaning up portfolio tracker', error);
            console.log(chalk.hex(COLORS.ERROR)("Error cleaning up portfolio tracker:"), error instanceof Error ? error.message : String(error));
        }
        
        // Clean up other resources as needed
        try {
            BlockhashManager.getInstance().cleanup();
        } catch (error) {
            systemLogger.error('CopyTradeHandler', 'Error cleaning up blockhash manager', error);
            console.log(chalk.hex(COLORS.ERROR)("Error cleaning up blockhash manager:"), error instanceof Error ? error.message : String(error));
        }
        
        logger.addLog({
            type: 'info',
            protocol: 'system',
            message: 'Exiting copy trade menu, all resources cleaned up'
        });
    } catch (error) {
        systemLogger.error('CopyTradeHandler', 'Error during cleanup', error);
        console.error(chalk.hex(COLORS.ERROR)("Error during cleanup:"), error instanceof Error ? error.message : String(error));
    }
}