//index.ts
import { displayMenu, handleMenuChoice } from './menu';
import { rl } from './utils/formatting';
import chalk from 'chalk';
import { CredentialsManager } from './utils/credentialsManager';
import { COLORS } from './config';

// Remove warning listeners
process.removeAllListeners('warning');

async function main(): Promise<void> {
    try {
        // Check for credentials instead of env variables
        const credManager = CredentialsManager.getInstance();
        if (!credManager.hasCredentials()) {
            console.log(chalk.hex(COLORS.PRIMARY)("\nNo credentials found. Please configure settings first."));
            console.log(chalk.hex(COLORS.PRIMARY)("1. Go to Settings"));
            console.log(chalk.hex(COLORS.PRIMARY)("2. Configure RPC URL"));
            console.log(chalk.hex(COLORS.PRIMARY)("3. Configure Private Key\n"));
        }

        let running = true;
        while (running) {
            displayMenu();
            const choice = await new Promise<string>(resolve => {
                rl.question(chalk.hex(COLORS.ACCENT)('Select an option: '), resolve);
            });

            running = await handleMenuChoice(choice);
        }
        rl.close();
    } catch (error) {
        console.error(chalk.hex(COLORS.ERROR)("Fatal error:"), error);
        process.exit(1);
    }
}

// Error handling
process.on('unhandledRejection', (error) => {
    console.error(chalk.hex(COLORS.ERROR)('Unhandled promise rejection:'), error);
    process.exit(1);
});

process.on('uncaughtException', (error) => {
    console.error(chalk.hex(COLORS.ERROR)('Uncaught exception:'), error);
    process.exit(1);
});

if (require.main === module) {
    main().catch(console.error);
}