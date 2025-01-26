// src/cli/menu.ts
import chalk from 'chalk';
import { CONFIG, COLORS, ASCII_BANNER } from './config';
import { rl } from './utils/formatting';
import { handleBuy } from './handlers/buyHandler';
import { handleSell } from './handlers/sellHandler';
import { handlePositions } from './handlers/positionsHandler';
import { handleSettings } from './handlers/settingsHandler';
import { handleCopyTrade } from './handlers/copyTradeHandler';

export function displayMenu(): void {
    console.clear();
    console.log(chalk.hex(COLORS.PRIMARY).bold(ASCII_BANNER));
    console.log(chalk.hex(COLORS.SECONDARY)("—".repeat(CONFIG.MENU_WIDTH)));
    console.log(chalk.white("1. ") + chalk.hex(COLORS.ACCENT)("Buy"));
    console.log(chalk.white("2. ") + chalk.hex(COLORS.ACCENT)("Sell"));
    console.log(chalk.white("3. ") + chalk.hex(COLORS.ACCENT)("Positions"));
    console.log(chalk.white("4. ") + chalk.hex(COLORS.ACCENT)("Balance"));
    console.log(chalk.white("5. ") + chalk.hex(COLORS.ACCENT)("Transfer"));
    console.log(chalk.white("6. ") + chalk.hex(COLORS.ACCENT)("Copy Trade"));
    console.log(chalk.white("7. ") + chalk.hex(COLORS.ACCENT)("Settings"));
    console.log(chalk.white("8. ") + chalk.hex(COLORS.ACCENT)("Exit"));
    console.log(chalk.hex(COLORS.SECONDARY)("—".repeat(CONFIG.MENU_WIDTH)));
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
            console.log(chalk.hex(COLORS.SUCCESS)("Goodbye!"));
            return false;
        default:
            console.log(chalk.red("Invalid option"));
    }

    await new Promise<void>(resolve => {
        rl.question(chalk.hex(COLORS.SECONDARY)('\nPress Enter to continue...'), () => resolve());
    });

    return true;
}