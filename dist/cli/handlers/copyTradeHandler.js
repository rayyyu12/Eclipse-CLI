"use strict";
// src/cli/handlers/copyTradeHandler.ts
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleCopyTrade = handleCopyTrade;
const chalk_1 = __importDefault(require("chalk"));
const formatting_1 = require("../utils/formatting");
const transactionMonitor_1 = require("../../copytrading/handlers/transactionMonitor");
const credentialsManager_1 = require("../utils/credentialsManager");
const walletStorage_1 = require("../utils/walletStorage");
const balanceUpdater_1 = require("../../copytrading/handlers/balanceUpdater");
const yellowstone_grpc_1 = require("@triton-one/yellowstone-grpc");
const blockhashManager_1 = require("../../utils/swaps/blockhashManager");
const copyTradeSettingsHandler_1 = require("./copyTradeSettingsHandler");
const copyTradeLogger_1 = require("../utils/copyTradeLogger");
const config_1 = require("../config");
const portfolioTracker_1 = require("../../utils/positions/portfolioTracker");
const logger_1 = require("../utils/logger");
let activeMonitor = null;
const walletStorage = walletStorage_1.WalletStorage.getInstance();
const logger = copyTradeLogger_1.CopyTradeLogger.getInstance();
const systemLogger = logger_1.Logger.getInstance();
async function handleCopyTrade() {
    while (true) {
        console.clear();
        const header = "Copy Trading Menu";
        const divider = "—".repeat(30);
        console.log(chalk_1.default.hex(config_1.COLORS.PRIMARY)(`\n${header}`));
        console.log(chalk_1.default.hex(config_1.COLORS.SECONDARY)(divider));
        // Show current status - with error handling
        try {
            if (activeMonitor?.getStatus().isActive) {
                const status = activeMonitor.getStatus();
                console.log(chalk_1.default.hex(config_1.COLORS.PRIMARY)("Monitor Status: ACTIVE"));
                console.log(chalk_1.default.hex(config_1.COLORS.ACCENT)(`Transactions Processed: ${status.processedTransactions}`));
                console.log(chalk_1.default.hex(config_1.COLORS.ACCENT)(`Swaps Detected: ${status.detectedSwaps}`));
                if (status.lastTransactionAt) {
                    console.log(chalk_1.default.hex(config_1.COLORS.ACCENT)(`Last Activity: ${status.lastTransactionAt.toLocaleString()}`));
                }
                // Add balance monitor status - with error handling
                try {
                    const balanceMonitor = balanceUpdater_1.BalanceMonitor.getInstance();
                    if (balanceMonitor.getStatus().isActive) {
                        console.log(chalk_1.default.hex(config_1.COLORS.PRIMARY)("\nWallet Balances:"));
                        console.log(chalk_1.default.hex(config_1.COLORS.ACCENT)(`SOL Balance: ${balanceMonitor.getCurrentBalance().toFixed(9)}`));
                        const status = balanceMonitor.getStatus();
                        if (status.lastUpdateTime) {
                            console.log(chalk_1.default.hex(config_1.COLORS.SECONDARY)(`Last Update: ${status.lastUpdateTime.toLocaleString()}`));
                        }
                    }
                }
                catch (error) {
                    console.log(chalk_1.default.hex(config_1.COLORS.ERROR)("Balance Monitor: ERROR"));
                    console.log(chalk_1.default.hex(config_1.COLORS.SECONDARY)(`Error: ${error instanceof Error ? error.message : String(error)}`));
                }
            }
            else {
                console.log(chalk_1.default.hex(config_1.COLORS.ERROR)("Monitor Status: INACTIVE"));
            }
        }
        catch (error) {
            console.log(chalk_1.default.hex(config_1.COLORS.ERROR)("Monitor Status: ERROR"));
            console.log(chalk_1.default.hex(config_1.COLORS.SECONDARY)(`Error: ${error instanceof Error ? error.message : String(error)}`));
        }
        // Show portfolio status - with error handling
        try {
            const portfolioTracker = portfolioTracker_1.PortfolioTracker.getInstance();
            const positions = await portfolioTracker.getAllPositions().catch(err => {
                console.log(chalk_1.default.hex(config_1.COLORS.ERROR)("Error fetching portfolio: " + (err instanceof Error ? err.message : String(err))));
                return { positions: [], totalValue: 0, totalPnl: 0, totalPnlPercentage: 0, lastUpdated: 0 };
            });
            console.log(chalk_1.default.hex(config_1.COLORS.PRIMARY)("\nPortfolio Status:"));
            console.log(chalk_1.default.hex(config_1.COLORS.ACCENT)(`Tracked Positions: ${positions.positions.length}`));
            console.log(chalk_1.default.hex(config_1.COLORS.ACCENT)(`Total Value: ${positions.totalValue.toFixed(6)} SOL`));
            console.log(chalk_1.default.hex(config_1.COLORS.ACCENT)(`Total PnL: ${positions.totalPnlPercentage.toFixed(2)}%`));
        }
        catch (error) {
            console.log(chalk_1.default.hex(config_1.COLORS.ERROR)("\nPortfolio: ERROR"));
            console.log(chalk_1.default.hex(config_1.COLORS.SECONDARY)(`Error: ${error instanceof Error ? error.message : String(error)}`));
        }
        // Show monitored wallets - with error handling
        try {
            const monitoredWallets = walletStorage.getWallets();
            if (monitoredWallets.size > 0) {
                console.log(chalk_1.default.hex(config_1.COLORS.PRIMARY)("\nMonitored Wallets:"));
                for (const wallet of monitoredWallets) {
                    console.log(chalk_1.default.hex(config_1.COLORS.ACCENT)(`  ${wallet}`));
                }
            }
            else {
                console.log(chalk_1.default.yellow("\nNo wallets currently monitored"));
            }
        }
        catch (error) {
            console.log(chalk_1.default.hex(config_1.COLORS.ERROR)("\nWallet Storage: ERROR"));
            console.log(chalk_1.default.hex(config_1.COLORS.SECONDARY)(`Error: ${error instanceof Error ? error.message : String(error)}`));
        }
        console.log(chalk_1.default.hex(config_1.COLORS.ACCENT)("1. Start Monitoring"));
        console.log(chalk_1.default.hex(config_1.COLORS.ACCENT)("2. Stop Monitoring"));
        console.log(chalk_1.default.hex(config_1.COLORS.ACCENT)("3. Add Wallet to Monitor"));
        console.log(chalk_1.default.hex(config_1.COLORS.ACCENT)("4. Remove Wallet"));
        console.log(chalk_1.default.hex(config_1.COLORS.ACCENT)("5. Copy Trade Settings"));
        console.log(chalk_1.default.hex(config_1.COLORS.ACCENT)("6. View Logs"));
        console.log(chalk_1.default.hex(config_1.COLORS.ACCENT)("7. Export Portfolio"));
        console.log(chalk_1.default.hex(config_1.COLORS.ACCENT)("8. Back to Main Menu"));
        const choice = await new Promise(resolve => {
            formatting_1.rl.question(chalk_1.default.hex(config_1.COLORS.PRIMARY)('\nSelect an option: '), resolve);
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
                    await (0, copyTradeSettingsHandler_1.handleCopyTradeSettings)();
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
                    console.log(chalk_1.default.hex(config_1.COLORS.ERROR)("Invalid option"));
            }
        }
        catch (error) {
            systemLogger.error('CopyTradeHandler', `Error handling option ${choice}`, error);
            console.log(chalk_1.default.hex(config_1.COLORS.ERROR)(`\nError: ${error instanceof Error ? error.message : String(error)}`));
        }
        if (shouldPromptForContinue) {
            await new Promise(resolve => {
                formatting_1.rl.question(chalk_1.default.hex(config_1.COLORS.SECONDARY)('\nPress Enter to continue...'), () => resolve());
            });
        }
    }
}
async function exportPortfolio() {
    try {
        console.log(chalk_1.default.hex(config_1.COLORS.PRIMARY)("\nExporting Portfolio to Discord..."));
        const portfolioTracker = portfolioTracker_1.PortfolioTracker.getInstance();
        await portfolioTracker.exportPortfolioToDiscord().catch(err => {
            throw new Error(`Export failed: ${err instanceof Error ? err.message : String(err)}`);
        });
        console.log(chalk_1.default.hex(config_1.COLORS.SUCCESS)("\nPortfolio exported successfully!"));
    }
    catch (error) {
        systemLogger.error('CopyTradeHandler', 'Failed to export portfolio', error);
        console.error(chalk_1.default.hex(config_1.COLORS.ERROR)("\nFailed to export portfolio:"), error);
    }
    await new Promise(resolve => {
        formatting_1.rl.question(chalk_1.default.hex(config_1.COLORS.SECONDARY)('\nPress Enter to continue...'), () => resolve());
    });
}
async function viewLogs() {
    console.clear();
    console.log(chalk_1.default.hex(config_1.COLORS.PRIMARY)("\nCopy Trade Logs"));
    console.log(chalk_1.default.hex(config_1.COLORS.SECONDARY)("—".repeat(30)));
    const displayLogs = () => {
        console.clear();
        console.log(chalk_1.default.hex(config_1.COLORS.PRIMARY)("\nCopy Trade Logs"));
        console.log(chalk_1.default.hex(config_1.COLORS.SECONDARY)("—".repeat(30)));
        const logs = logger.getLogs(50); // Get last 50 logs
        if (logs.length === 0) {
            console.log(chalk_1.default.yellow("\nNo logs available"));
        }
        else {
            logs.forEach(log => {
                try {
                    console.log(logger.formatLog(log));
                }
                catch (error) {
                    console.log(chalk_1.default.hex(config_1.COLORS.ERROR)(`Error formatting log: ${error instanceof Error ? error.message : String(error)}`));
                }
            });
        }
        console.log(chalk_1.default.hex(config_1.COLORS.ACCENT)("\n1. Stop Auto-Update"));
        console.log(chalk_1.default.hex(config_1.COLORS.ACCENT)("2. Clear Logs"));
        console.log(chalk_1.default.hex(config_1.COLORS.ACCENT)("3. Back to Copy Trading Menu"));
    };
    // Set up event listeners for auto-updating
    const handleNewLog = () => {
        try {
            displayLogs();
        }
        catch (error) {
            console.error("Error updating logs display:", error instanceof Error ? error.message : String(error));
        }
    };
    const handleLogsCleared = () => {
        try {
            displayLogs();
        }
        catch (error) {
            console.error("Error refreshing logs after clear:", error instanceof Error ? error.message : String(error));
        }
    };
    try {
        logger.on('newLog', handleNewLog);
        logger.on('logsCleared', handleLogsCleared);
        // Initial display
        displayLogs();
        while (true) {
            const choice = await new Promise(resolve => {
                formatting_1.rl.question(chalk_1.default.hex(config_1.COLORS.PRIMARY)('\nSelect an option: '), resolve);
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
                    }
                    catch (error) {
                        console.error("Error clearing logs:", error instanceof Error ? error.message : String(error));
                    }
                    break;
                case "3":
                    // Clean up event listeners before returning
                    logger.removeListener('newLog', handleNewLog);
                    logger.removeListener('logsCleared', handleLogsCleared);
                    return;
                default:
                    console.log(chalk_1.default.hex(config_1.COLORS.ERROR)("Invalid option"));
                    await new Promise(resolve => {
                        formatting_1.rl.question(chalk_1.default.hex(config_1.COLORS.SECONDARY)('\nPress Enter to continue...'), () => resolve());
                    });
            }
        }
    }
    catch (error) {
        // Handle any errors in the log viewer
        systemLogger.error('CopyTradeHandler', 'Error in log viewer', error);
        console.error(chalk_1.default.hex(config_1.COLORS.ERROR)("Error in log viewer:"), error instanceof Error ? error.message : String(error));
        // Clean up event listeners
        logger.removeListener('newLog', handleNewLog);
        logger.removeListener('logsCleared', handleLogsCleared);
    }
}
async function startMonitoring() {
    if (activeMonitor?.getStatus().isActive) {
        console.log(chalk_1.default.yellow("Monitor is already running!"));
        return;
    }
    const monitoredWallets = walletStorage.getWallets();
    if (monitoredWallets.size === 0) {
        console.log(chalk_1.default.yellow("Please add at least one wallet to monitor first!"));
        return;
    }
    const credManager = credentialsManager_1.CredentialsManager.getInstance();
    if (!credManager.hasBasicCredentials()) {
        console.log(chalk_1.default.hex(config_1.COLORS.ERROR)("Please configure RPC settings in the Settings menu first!"));
        return;
    }
    try {
        // Initialize portfolio tracking first - with error handling
        console.log(chalk_1.default.hex(config_1.COLORS.PRIMARY)("Initializing portfolio tracking..."));
        try {
            const portfolioTracker = portfolioTracker_1.PortfolioTracker.getInstance();
            await portfolioTracker.initializeBalanceMonitoring()
                .catch(error => {
                systemLogger.warn('CopyTradeHandler', 'Portfolio tracking initialization failed', error);
                console.log(chalk_1.default.hex(config_1.COLORS.SECONDARY)('Portfolio initialization error, continuing with monitor setup'));
            });
        }
        catch (error) {
            systemLogger.warn('CopyTradeHandler', 'Portfolio tracking initialization failed', error);
            console.log(chalk_1.default.hex(config_1.COLORS.SECONDARY)('Portfolio initialization error, continuing with monitor setup'));
        }
        // Get URLs - with error handling and fallbacks
        let grpcUrl;
        let rpcUrl;
        try {
            grpcUrl = credManager.getGrpcUrl();
            rpcUrl = credManager.getRpcUrl();
        }
        catch {
            // Fallback: use RPC URL for both if GRPC fails
            try {
                rpcUrl = credManager.getRpcUrl();
                grpcUrl = rpcUrl;
                console.log(chalk_1.default.hex(config_1.COLORS.SECONDARY)("GRPC URL not found, using RPC URL as fallback"));
            }
            catch (error) {
                systemLogger.error('CopyTradeHandler', 'Failed to get URLS', error);
                throw new Error("Failed to get required URLs. Please check your settings.");
            }
        }
        // Initialize BlockhashManager - with error handling
        try {
            const connection = credManager.getConnection();
            blockhashManager_1.BlockhashManager.getInstance().initialize(connection);
        }
        catch (error) {
            systemLogger.warn('CopyTradeHandler', 'BlockhashManager initialization failed', error);
            console.log(chalk_1.default.hex(config_1.COLORS.SECONDARY)("BlockhashManager initialization failed, some features may be limited"));
        }
        // Get optional auth token
        let authToken;
        try {
            authToken = credManager.getAuthToken();
        }
        catch {
            // Auth token is optional
        }
        // Initialize balance monitor for each wallet
        for (const wallet of monitoredWallets) {
            try {
                await balanceUpdater_1.BalanceMonitor.initialize({
                    grpcEndpoint: grpcUrl, // For gRPC subscription
                    rpcEndpoint: rpcUrl, // For RPC balance check
                    xToken: authToken,
                    wallet,
                    commitment: yellowstone_grpc_1.CommitmentLevel.PROCESSED
                }).catch(error => {
                    systemLogger.warn('CopyTradeHandler', `Failed to initialize balance monitor for ${wallet}`, error);
                    console.log(chalk_1.default.hex(config_1.COLORS.SECONDARY)(`Balance monitor setup failed for ${wallet}, continuing...`));
                });
                const balanceMonitor = balanceUpdater_1.BalanceMonitor.getInstance();
                balanceMonitor.on('error', (error) => {
                    systemLogger.warn('BalanceMonitor', 'Error event received', error);
                    console.log(chalk_1.default.hex(config_1.COLORS.ERROR)(`\nBalance Monitor Error: ${error instanceof Error ? error.message : String(error)}`));
                });
            }
            catch (error) {
                systemLogger.error('CopyTradeHandler', `Failed to initialize balance monitor for ${wallet}`, error);
                console.log(chalk_1.default.hex(config_1.COLORS.ERROR)(`Failed to initialize balance monitor for wallet ${wallet}:`), error instanceof Error ? error.message : String(error));
            }
        }
        // Initialize transaction monitor
        activeMonitor = new transactionMonitor_1.TransactionMonitor({
            grpcEndpoint: grpcUrl,
            xToken: authToken,
            wallets: Array.from(monitoredWallets),
            enablePump: true,
            enableRaydium: true
        });
        activeMonitor.on('swap', (swapData) => {
            console.log(chalk_1.default.hex(config_1.COLORS.SUCCESS)('\nSwap Detected!'));
            console.log(chalk_1.default.hex(config_1.COLORS.ACCENT)(`Type: ${swapData.swapType}`));
            console.log(chalk_1.default.hex(config_1.COLORS.ACCENT)(`Token: ${swapData.tokenAddress.toString()}`));
            if (swapData.amountIn) {
                console.log(chalk_1.default.hex(config_1.COLORS.ACCENT)(`Amount: ${swapData.amountIn} lamports`));
            }
        });
        activeMonitor.on('error', (error) => {
            systemLogger.warn('TransactionMonitor', 'Error event received', error);
            console.log(chalk_1.default.hex(config_1.COLORS.ERROR)(`\nTransaction Monitor Error: ${error instanceof Error ? error.message : String(error)}`));
        });
        await activeMonitor.start().catch(error => {
            systemLogger.error('CopyTradeHandler', 'Failed to start monitor', error);
            throw new Error(`Failed to start monitor: ${error instanceof Error ? error.message : String(error)}`);
        });
        console.log(chalk_1.default.hex(config_1.COLORS.SUCCESS)("\nMonitor started successfully!"));
    }
    catch (error) {
        systemLogger.error('CopyTradeHandler', 'Failed to start monitors', error);
        console.error(chalk_1.default.hex(config_1.COLORS.ERROR)("Failed to start monitors:"), error instanceof Error ? error.message : String(error));
        // Make sure activeMonitor is null if starting it failed
        activeMonitor = null;
    }
}
async function stopMonitoring() {
    if (!activeMonitor?.getStatus().isActive) {
        console.log(chalk_1.default.yellow("Monitor is not running!"));
        return;
    }
    try {
        await activeMonitor.stop();
        console.log(chalk_1.default.hex(config_1.COLORS.SUCCESS)("Monitor stopped successfully!"));
    }
    catch (error) {
        systemLogger.error('CopyTradeHandler', 'Failed to stop monitor', error);
        console.error(chalk_1.default.hex(config_1.COLORS.ERROR)("Failed to stop monitor:"), error instanceof Error ? error.message : String(error));
    }
}
async function addWallet() {
    const walletAddress = await new Promise(resolve => {
        formatting_1.rl.question(chalk_1.default.hex(config_1.COLORS.PRIMARY)('Enter wallet address to monitor: '), resolve);
    });
    try {
        if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(walletAddress)) {
            throw new Error("Invalid Solana wallet address format");
        }
        walletStorage.addWallet(walletAddress);
        if (activeMonitor?.getStatus().isActive) {
            try {
                activeMonitor.addWallet(walletAddress);
            }
            catch (error) {
                systemLogger.warn('CopyTradeHandler', `Failed to add wallet to active monitor: ${walletAddress}`, error);
                console.log(chalk_1.default.hex(config_1.COLORS.SECONDARY)("Wallet added to storage but not to active monitor. You may need to restart monitoring."));
            }
        }
        console.log(chalk_1.default.hex(config_1.COLORS.SUCCESS)(`Added wallet: ${walletAddress}`));
    }
    catch (error) {
        systemLogger.error('CopyTradeHandler', `Failed to add wallet: ${walletAddress}`, error);
        console.error(chalk_1.default.hex(config_1.COLORS.ERROR)("Failed to add wallet:"), error instanceof Error ? error.message : String(error));
    }
}
async function removeWallet() {
    try {
        const monitoredWallets = walletStorage.getWallets();
        if (monitoredWallets.size === 0) {
            console.log(chalk_1.default.yellow("No wallets to remove!"));
            return;
        }
        const walletAddress = await new Promise(resolve => {
            formatting_1.rl.question(chalk_1.default.hex(config_1.COLORS.PRIMARY)('Enter wallet address to remove: '), resolve);
        });
        if (monitoredWallets.has(walletAddress)) {
            walletStorage.removeWallet(walletAddress);
            if (activeMonitor?.getStatus().isActive) {
                try {
                    activeMonitor.removeWallet(walletAddress);
                }
                catch (error) {
                    systemLogger.warn('CopyTradeHandler', `Failed to remove wallet from active monitor: ${walletAddress}`, error);
                    console.log(chalk_1.default.hex(config_1.COLORS.SECONDARY)("Wallet removed from storage but not from active monitor. You may need to restart monitoring."));
                }
            }
            console.log(chalk_1.default.hex(config_1.COLORS.SUCCESS)(`Removed wallet: ${walletAddress}`));
        }
        else {
            console.log(chalk_1.default.yellow("Wallet not found in monitored list!"));
        }
    }
    catch (error) {
        systemLogger.error('CopyTradeHandler', 'Failed to remove wallet', error);
        console.error(chalk_1.default.hex(config_1.COLORS.ERROR)("Failed to remove wallet:"), error instanceof Error ? error.message : String(error));
    }
}
async function cleanupBeforeExit() {
    try {
        // Stop any active monitoring
        if (activeMonitor?.getStatus().isActive) {
            try {
                await activeMonitor.stop();
            }
            catch (error) {
                systemLogger.error('CopyTradeHandler', 'Error stopping active monitor during cleanup', error);
                console.log(chalk_1.default.hex(config_1.COLORS.ERROR)("Error stopping monitor:"), error instanceof Error ? error.message : String(error));
            }
        }
        // Clean up portfolio tracker
        try {
            await portfolioTracker_1.PortfolioTracker.getInstance().cleanup();
        }
        catch (error) {
            systemLogger.error('CopyTradeHandler', 'Error cleaning up portfolio tracker', error);
            console.log(chalk_1.default.hex(config_1.COLORS.ERROR)("Error cleaning up portfolio tracker:"), error instanceof Error ? error.message : String(error));
        }
        // Clean up other resources as needed
        try {
            blockhashManager_1.BlockhashManager.getInstance().cleanup();
        }
        catch (error) {
            systemLogger.error('CopyTradeHandler', 'Error cleaning up blockhash manager', error);
            console.log(chalk_1.default.hex(config_1.COLORS.ERROR)("Error cleaning up blockhash manager:"), error instanceof Error ? error.message : String(error));
        }
        logger.addLog({
            type: 'info',
            protocol: 'system',
            message: 'Exiting copy trade menu, all resources cleaned up'
        });
    }
    catch (error) {
        systemLogger.error('CopyTradeHandler', 'Error during cleanup', error);
        console.error(chalk_1.default.hex(config_1.COLORS.ERROR)("Error during cleanup:"), error instanceof Error ? error.message : String(error));
    }
}
