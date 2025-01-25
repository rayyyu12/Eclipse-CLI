// src/cli/menu.ts
import chalk from 'chalk';
import { CONFIG } from './config';
import { rl } from './utils/formatting';
import { handleBuy } from './handlers/buyHandler';
import { handleSell } from './handlers/sellHandler';
import { handlePositions } from './handlers/positionsHandler';
import { handleSettings } from './handlers/settingsHandler';
import { handleCopyTrade } from './handlers/copyTradeHandler';

export function displayMenu(): void {
    console.clear();
    console.log(chalk.cyan.bold("\nEclipse Trading CLI"));
    console.log(chalk.gray("—".repeat(CONFIG.MENU_WIDTH)));
    console.log(chalk.white("1. ") + chalk.green("Buy"));
    console.log(chalk.white("2. ") + chalk.red("Sell"));
    console.log(chalk.white("3. ") + chalk.blue("Positions"));
    console.log(chalk.white("4. ") + chalk.yellow("Balance"));
    console.log(chalk.white("5. ") + chalk.magenta("Transfer"));
    console.log(chalk.white("6. ") + chalk.cyan("Copy Trade"));
    console.log(chalk.white("7. ") + chalk.gray("Settings"));
    console.log(chalk.white("8. ") + chalk.red("Exit"));
    console.log(chalk.gray("—".repeat(CONFIG.MENU_WIDTH)));
}

export async function handleMenuChoice(choice: string): Promise<boolean> {
    console.clear();
    
    switch (choice) {
        case CONFIG.COMMANDS.BUY:
            await handleBuy();
            break;
        case CONFIG.COMMANDS.SELL:
            await handleSell();
            break;
        case CONFIG.COMMANDS.POSITIONS:
            await handlePositions();
            break;
        case CONFIG.COMMANDS.BALANCE:
            console.log(chalk.yellow("Balance feature coming soon..."));
            break;
        case CONFIG.COMMANDS.TRANSFER:
            console.log(chalk.yellow("Transfer feature coming soon..."));
            break;
        case CONFIG.COMMANDS.COPY_TRADE:
            await handleCopyTrade();
            break;
        case CONFIG.COMMANDS.SETTINGS:
            await handleSettings();
            break;
        case CONFIG.COMMANDS.EXIT:
            console.log(chalk.green("Goodbye!"));
            return false;
        default:
            console.log(chalk.red("Invalid option"));
    }

    await new Promise<void>(resolve => {
        rl.question(chalk.gray('\nPress Enter to continue...'), () => resolve());
    });

    return true;
}