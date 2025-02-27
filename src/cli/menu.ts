// src/cli/menu.ts
import chalk from 'chalk';
import { CONFIG, COLORS, ASCII_BANNER } from './config';
import { rl } from './utils/formatting';
import { handleBuy } from './handlers/buyHandler';
import { handleSell } from './handlers/sellHandler';
import { handlePositions } from './handlers/positionsHandler';
import { handleSettings } from './handlers/settingsHandler';
import { CredentialsManager } from './utils/credentialsManager';

const credentialsManager = CredentialsManager.getInstance();

async function checkRpcUrl(): Promise<boolean> {
    try {
        credentialsManager.getRpcUrl();
        return true;
    } catch {
        console.log(chalk.hex(COLORS.ERROR)('Please set RPC URL in settings first'));
        return false;
    }
}

async function checkPrivateKey(): Promise<boolean> {
    try {
        credentialsManager.getPrivateKey();
        return true;
    } catch {
        console.log(chalk.hex(COLORS.ERROR)('Please set private key in settings first'));
        return false;
    }
}

async function checkCopyTradeRequirements(): Promise<boolean> {
    let hasRequirements = true;
    
    try {
        credentialsManager.getRpcUrl();
    } catch {
        console.log(chalk.hex(COLORS.ERROR)('Please set RPC URL in settings'));
        hasRequirements = false;
    }
    
    try {
        credentialsManager.getGrpcUrl();
    } catch {
        console.log(chalk.hex(COLORS.ERROR)('Please set GRPC URL in settings'));
        hasRequirements = false;
    }
    
    return hasRequirements;
}

export function displayMenu(): void {
    console.clear();
    console.log(chalk.hex(COLORS.LOGO).bold(ASCII_BANNER));
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
            if (await checkRpcUrl()) {
                await handleBuy();
            }
            break;
            
        case CONFIG.COMMANDS.SELL:
            if (await checkRpcUrl()) {
                await handleSell();
            }
            break;
            
        case CONFIG.COMMANDS.POSITIONS:
            if (await checkPrivateKey()) {
                await handlePositions();
            }
            break;
            
        case CONFIG.COMMANDS.BALANCE:
            if (await checkPrivateKey()) {
                console.log(chalk.yellow("Balance feature coming soon..."));
            }
            break;
            
        case CONFIG.COMMANDS.TRANSFER:
            if (await checkPrivateKey()) {
                console.log(chalk.yellow("Transfer feature coming soon..."));
            }
            break;
            
        case CONFIG.COMMANDS.COPY_TRADE:
            if (await checkCopyTradeRequirements()) {
                console.log(chalk.yellow("Premium Feature..."));
            }
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