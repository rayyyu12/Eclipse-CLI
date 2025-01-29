// src/cli/index.ts

// Suppress WebSocket and rate limit messages
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
import { TokenBalanceMonitor } from '../utils/positions/tokenBalanceMonitor';
import { Connection, PublicKey } from '@solana/web3.js';

process.removeAllListeners('warning');

/**
 * Initialize portfolio and token monitoring in the background.
 * This doesn't block the user from seeing the menu right away.
 */
function startBackgroundMonitoring(connection: Connection, walletPubkey: PublicKey): void {
    Promise.resolve().then(async () => {
        try {
            const portfolio = PortfolioTracker.getInstance();
            await portfolio.initializeBalanceMonitoring();

            const tokenBalanceMonitor = TokenBalanceMonitor.getInstance();
            await tokenBalanceMonitor.monitorAllPositions(connection, walletPubkey);

            const existingPositions = await portfolio.getAllPositions();
            for (const pos of existingPositions.positions) {
                await tokenBalanceMonitor.startMonitoring(connection, walletPubkey, pos.tokenAddress);
            }
        } catch (error) {
            // Only log truly fatal errors
            if (!(error instanceof Error) || !error.message.includes('429')) {
                console.error(chalk.hex(COLORS.ERROR)('\nFatal monitoring error:'), error);
            }
        }
    });
}

async function main(): Promise<void> {
    try {
        const credManager = CredentialsManager.getInstance();

        if (!credManager.hasCredentials()) {
            console.log(chalk.hex(COLORS.PRIMARY)("\nNo credentials found. Please configure settings first."));
            console.log(chalk.hex(COLORS.PRIMARY)("1. Go to Settings"));
            console.log(chalk.hex(COLORS.PRIMARY)("2. Configure RPC URL"));
            console.log(chalk.hex(COLORS.PRIMARY)("3. Configure Private Key\n"));
        } else {
            const connection = credManager.getConnection();
            const wallet = credManager.getKeyPair();
            startBackgroundMonitoring(connection, wallet.publicKey);
        }

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

        rl.close();
    } catch (error) {
        if (!(error instanceof Error) || !error.message.includes('429')) {
            console.error(chalk.hex(COLORS.ERROR)("\nFatal error occurred. Please check your settings and try again."));
        }
        process.exit(1);
    }
}

// Suppress unhandled rejections unless truly fatal
process.on('unhandledRejection', (error) => {
    if (!(error instanceof Error) || !error.message.includes('429')) {
        console.error(chalk.hex(COLORS.ERROR)('\nFatal error:'), error);
        process.exit(1);
    }
});

// Suppress uncaught exceptions unless truly fatal
process.on('uncaughtException', (error) => {
    if (!(error instanceof Error) || !error.message.includes('429')) {
        console.error(chalk.hex(COLORS.ERROR)('\nFatal error:'), error);
        process.exit(1);
    }
});

// Start the application
if (require.main === module) {
    main().catch((error) => {
        if (!(error instanceof Error) || !error.message.includes('429')) {
            console.error(chalk.hex(COLORS.ERROR)("\nFatal error occurred. Please check your settings and try again."));
        }
        process.exit(1);
    });
}