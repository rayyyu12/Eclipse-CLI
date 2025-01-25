//index.ts
import { displayMenu, handleMenuChoice } from './menu';
import { rl } from './utils/formatting';
import chalk from 'chalk';
import { CredentialsManager } from './utils/credentialsManager';

// Remove warning listeners
process.removeAllListeners('warning');

async function main(): Promise<void> {
    try {
        // Check for credentials instead of env variables
        const credManager = CredentialsManager.getInstance();
        if (!credManager.hasCredentials()) {
            console.log(chalk.yellow("\nNo credentials found. Please configure settings first."));
            console.log(chalk.yellow("1. Go to Settings"));
            console.log(chalk.yellow("2. Configure RPC URL"));
            console.log(chalk.yellow("3. Configure Private Key\n"));
        }

        let running = true;
        while (running) {
            displayMenu();
            const choice = await new Promise<string>(resolve => {
                rl.question(chalk.cyan('Select an option: '), resolve);
            });

            running = await handleMenuChoice(choice);
        }
        rl.close();
    } catch (error) {
        console.error(chalk.red("Fatal error:"), error);
        process.exit(1);
    }
}

// Error handling
process.on('unhandledRejection', (error) => {
    console.error(chalk.red('Unhandled promise rejection:'), error);
    process.exit(1);
});

process.on('uncaughtException', (error) => {
    console.error(chalk.red('Uncaught exception:'), error);
    process.exit(1);
});

if (require.main === module) {
    main().catch(console.error);
}