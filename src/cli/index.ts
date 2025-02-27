// src/cli/index.ts

// Set up error filtering for common rate limit errors
const originalConsoleError = console.error;
const originalConsoleLog = console.log;

console.error = (...args) => {
    const message = args.join(' ');
    if (message.includes('429') || 
        message.includes('ws error') || 
        message.includes('Too Many Requests') ||
        message.includes('WebSocket') ||
        message.includes('Retrying after')) {
        return;
    }
    originalConsoleError.apply(console, args);
};

console.log = (...args) => {
    const message = args.join(' ');
    if (message.includes('Retrying after') || 
        message.includes('429') ||
        message.includes('Too Many Requests')) {
        return;
    }
    originalConsoleLog.apply(console, args);
};

import { displayMenu, handleMenuChoice } from './menu';
import { rl } from './utils/formatting';
import chalk from 'chalk';
import { CredentialsManager } from './utils/credentialsManager';
import { COLORS } from './config';
import { PortfolioTracker } from '../utils/positions/portfolioTracker';
import { Connection, PublicKey } from '@solana/web3.js';
import { BlockhashManager } from '../utils/swaps/blockhashManager';
import { Logger, LogLevel } from './utils/logger';
import { ConnectionPool } from '../utils/connection/connectionPool';

// Suppress Node.js warnings
process.removeAllListeners('warning');

/**
 * Global application state
 */
const appState = {
    initialized: false,
    initializing: false,
    shuttingDown: false
};

// Initialize logger
const logger = Logger.getInstance();
logger.initialize({
    logLevel: LogLevel.INFO,
    logToFile: true
});

/**
 * Initialize all services needed by the application
 */
async function initializeServices(): Promise<boolean> {
    if (appState.initialized || appState.initializing) {
        return appState.initialized;
    }
    
    appState.initializing = true;
    
    try {
        const credManager = CredentialsManager.getInstance();

        if (!credManager.hasCredentials()) {
            logger.warn('App', 'No credentials found. User needs to configure settings.');
            console.log(chalk.hex(COLORS.PRIMARY)("\nNo credentials found. Please configure settings first."));
            console.log(chalk.hex(COLORS.PRIMARY)("1. Go to Settings"));
            console.log(chalk.hex(COLORS.PRIMARY)("2. Configure RPC URL"));
            console.log(chalk.hex(COLORS.PRIMARY)("3. Configure Private Key\n"));
            appState.initializing = false;
            return false;
        }

        logger.info('App', 'Initializing services...');
        
        // Initialize connection pool - with error handling
        try {
            const connPool = ConnectionPool.getInstance();
            connPool.initialize();
            logger.success('App', 'Connection pool initialized successfully');
        } catch (error) {
            logger.warn('App', 'Failed to initialize connection pool', error);
            console.log(chalk.hex(COLORS.ERROR)("Warning: Connection pool initialization failed. Some features may be limited."));
            // Continue despite error
        }
        
        // Initialize blockhash manager with a connection from the pool - with error handling
        try {
            const connection = credManager.getConnection();
            BlockhashManager.getInstance().initialize(connection);
            logger.success('App', 'Blockhash manager initialized successfully');
        } catch (error) {
            logger.warn('App', 'Failed to initialize BlockhashManager', error);
            console.log(chalk.hex(COLORS.ERROR)("Warning: Blockhash manager initialization failed. Some features may be limited."));
            // Continue despite error
        }
        
        // Initialize portfolio tracking in background - with error handling
        try {
            const wallet = credManager.getKeyPair();
            const connection = credManager.getConnection();
            startBackgroundMonitoring(connection, wallet.publicKey).catch(error => {
                logger.warn('App', 'Background monitoring initialization failed', error);
            });
        } catch (error) {
            logger.warn('App', 'Failed to start background monitoring', error);
            console.log(chalk.hex(COLORS.ERROR)("Warning: Portfolio monitoring initialization failed. Some features may be limited."));
            // Continue despite error
        }
        
        appState.initialized = true;
        appState.initializing = false;
        logger.success('App', 'Services initialized successfully');
        return true;
    } catch (error) {
        logger.error('App', 'Failed to initialize services', error);
        console.error(chalk.hex(COLORS.ERROR)('\nWarning: Failed to initialize some services. Some features may be limited.'));
        appState.initializing = false;
        return false;
    }
}

/**
 * Initialize portfolio and token monitoring in the background.
 * This doesn't block the user from seeing the menu right away.
 */
function startBackgroundMonitoring(connection: Connection, walletPubkey: PublicKey): Promise<void> {
    return new Promise((resolve, reject) => {
        setTimeout(async () => {
            try {
                const portfolio = PortfolioTracker.getInstance();
                await portfolio.initializeBalanceMonitoring()
                    .catch(error => {
                        logger.warn('App', 'Portfolio monitoring initialization error (background)', error);
                        // Don't reject, just log the error and continue
                    });
                logger.success('App', 'Portfolio monitoring initialized');
                resolve();
            } catch (error) {
                // Only log truly fatal errors
                if (!(error instanceof Error) || !error.message.includes('429')) {
                    logger.error('App', 'Portfolio monitoring initialization error (background)', error);
                }
                // Don't reject, we want to continue even if this fails
                resolve();
            }
        }, 100); // Small delay to let the main thread continue
    });
}

/**
 * Cleanup resources before exit
 */
async function cleanup(): Promise<void> {
    if (appState.shuttingDown) return;
    
    appState.shuttingDown = true;
    logger.info('App', 'Cleaning up resources...');
    
    try {
        // Cleanup portfolio tracker
        try {
            await PortfolioTracker.getInstance().cleanup();
        } catch (error) {
            logger.warn('App', 'Error cleaning up portfolio tracker', error);
        }
        
        // Cleanup blockhash manager
        try {
            BlockhashManager.getInstance().cleanup();
        } catch (error) {
            logger.warn('App', 'Error cleaning up blockhash manager', error);
        }
        
        // Cleanup connection pool
        try {
            ConnectionPool.getInstance().cleanup();
        } catch (error) {
            logger.warn('App', 'Error cleaning up connection pool', error);
        }
        
        // Close readline interface
        rl.close();
        
        logger.success('App', 'Resources cleaned up successfully');
    } catch (error) {
        logger.error('App', 'Error during cleanup', error);
    }
}

async function main(): Promise<void> {
    try {
        // Initialize services (credentials, connection, etc.)
        await initializeServices();

        let running = true;
        while (running) {
            displayMenu();
            const choice = await new Promise<string>((resolve) => {
                rl.question(
                    chalk.hex(COLORS.ACCENT)('Select an option: '),
                    resolve
                );
            });

            running = await handleMenuChoice(choice);
        }

        await cleanup();
    } catch (error) {
        if (!(error instanceof Error) || !error.message.includes('429')) {
            logger.error('App', 'Fatal error occurred', error);
            console.error(chalk.hex(COLORS.ERROR)("\nFatal error occurred. Please check your settings and try again."));
        }
        await cleanup();
        process.exit(1);
    }
}

// Handle graceful shutdown
process.on('SIGINT', async () => {
    logger.info('App', 'Received SIGINT signal, shutting down');
    console.log(chalk.hex(COLORS.PRIMARY)("\nShutting down..."));
    await cleanup();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    logger.info('App', 'Received SIGTERM signal, shutting down');
    console.log(chalk.hex(COLORS.PRIMARY)("\nShutting down..."));
    await cleanup();
    process.exit(0);
});

// Suppress unhandled rejections unless truly fatal
process.on('unhandledRejection', async (error) => {
    // List of error messages that should not crash the application
    const nonFatalErrors = [
        '429',
        'Too Many Requests',
        'fetch failed',
        'failed to get recent blockhash',
        'Socket hang up',
        'ETIMEDOUT',
        'ECONNRESET',
        'ECONNREFUSED',
        'request timed out',
        'timeout',
        'blockhash not found',
        'WebSocket',
        'ws error'
    ];
    
    // Check if error contains any of the non-fatal messages
    const isFatal = !(error instanceof Error) ||
        !nonFatalErrors.some(msg => error.message.toLowerCase().includes(msg.toLowerCase()));
        
    if (isFatal) {
        logger.error('App', 'Unhandled promise rejection', error);
        console.error(chalk.hex(COLORS.ERROR)('\nFatal error occurred:'), error);
        await cleanup();
        process.exit(1);
    } else {
        // For non-fatal errors, just log them
        logger.warn('App', 'Non-fatal unhandled promise rejection', error);
        console.warn(chalk.hex(COLORS.ERROR)('\nWarning: Non-fatal error occurred:'), 
            error instanceof Error ? error.message : String(error));
    }
});

// Suppress uncaught exceptions unless truly fatal
process.on('uncaughtException', async (error) => {
    // List of error messages that should not crash the application
    const nonFatalErrors = [
        '429',
        'Too Many Requests',
        'fetch failed',
        'failed to get recent blockhash',
        'Socket hang up',
        'ETIMEDOUT',
        'ECONNRESET',
        'ECONNREFUSED',
        'request timed out',
        'timeout',
        'WebSocket',
        'ws error'
    ];
    
    // Check if error contains any of the non-fatal messages
    const isFatal = !(error instanceof Error) ||
        !nonFatalErrors.some(msg => error.message.toLowerCase().includes(msg.toLowerCase()));
        
    if (isFatal) {
        logger.error('App', 'Uncaught exception', error);
        console.error(chalk.hex(COLORS.ERROR)('\nFatal error occurred:'), error);
        await cleanup();
        process.exit(1);
    } else {
        // For non-fatal errors, just log them
        logger.warn('App', 'Non-fatal uncaught exception', error);
        console.warn(chalk.hex(COLORS.ERROR)('\nWarning: Non-fatal error occurred:'), 
            error instanceof Error ? error.message : String(error));
    }
});

// Export setup for use in other modules
export async function setupConnection() {
    await initializeServices();
    const credManager = CredentialsManager.getInstance();
    const connection = ConnectionPool.getInstance().getConnection();
    const wallet = credManager.getKeyPair();
    return { connection, wallet };
}

// Start the application
if (require.main === module) {
    main().catch(async (error) => {
        if (!(error instanceof Error) || !error.message.includes('429')) {
            logger.error('App', 'Fatal startup error', error);
            console.error(chalk.hex(COLORS.ERROR)("\nFatal error occurred. Please check your settings and try again."));
        }
        await cleanup();
        process.exit(1);
    });
}