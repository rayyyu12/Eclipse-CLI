// src/cli/handlers/copyTradeSettingsHandler.ts

import chalk from 'chalk';
import { rl } from '../utils/formatting';
import { BuyMode, CopyTradeSettingsManager } from '../utils/copyTradingSettings';

export async function handleCopyTradeSettings(): Promise<void> {
    const settingsManager = CopyTradeSettingsManager.getInstance();
    
    while (true) {
        console.clear();
        const header = "Copy Trading Settings";
        const divider = "—".repeat(30);
        
        console.log(chalk.cyan.bold(`\n${header}`));
        console.log(chalk.gray(divider));

        const settings = settingsManager.getSettings();

        // Display current settings
        console.log(chalk.cyan("\nBuy Settings:"));
        console.log(chalk.white(`Buy Mode: ${settings.buyMode}`));
        console.log(chalk.white(`Fixed Buy Amount: ${settings.fixedBuyAmount} SOL`));
        console.log(chalk.white(`Mirror Percentage: ${settings.mirrorPercentage}%`));
        
        console.log(chalk.cyan("\nFilters:"));
        console.log(chalk.white(`Min Buy Amount: ${settings.minBuyAmount} SOL`));
        console.log(chalk.white(`Max Buy Amount: ${settings.maxBuyAmount} SOL`));
        console.log(chalk.white(`Slippage Tolerance: ${settings.slippageTolerance}%`));
        
        console.log(chalk.cyan("\nEnabled Protocols:"));
        console.log(chalk.white(`Pump.fun: ${settings.enabled.pump ? 'Yes' : 'No'}`));
        console.log(chalk.white(`Raydium: ${settings.enabled.raydium ? 'Yes' : 'No'}`));

        console.log(chalk.white("\n1. Change Buy Mode"));
        console.log(chalk.white("2. Set Fixed Buy Amount"));
        console.log(chalk.white("3. Set Mirror Percentage"));
        console.log(chalk.white("4. Set Min Buy Amount"));
        console.log(chalk.white("5. Set Max Buy Amount"));
        console.log(chalk.white("6. Set Slippage Tolerance"));
        console.log(chalk.white("7. Toggle Protocols"));
        console.log(chalk.white("8. Back to Copy Trading Menu"));
        
        const choice = await new Promise<string>(resolve => {
            rl.question(chalk.cyan('\nSelect an option: '), resolve);
        });

        switch (choice) {
            case "1":
                await changeBuyMode(settingsManager);
                break;
            case "2":
                await setFixedBuyAmount(settingsManager);
                break;
            case "3":
                await setMirrorPercentage(settingsManager);
                break;
            case "4":
                await setMinBuyAmount(settingsManager);
                break;
            case "5":
                await setMaxBuyAmount(settingsManager);
                break;
            case "6":
                await setSlippageTolerance(settingsManager);
                break;
            case "7":
                await toggleProtocols(settingsManager);
                break;
            case "8":
                return;
            default:
                console.log(chalk.red("Invalid option"));
        }

        if (choice !== "8") {
            await new Promise<void>(resolve => {
                rl.question(chalk.gray('\nPress Enter to continue...'), () => resolve());
            });
        }
    }
}

async function changeBuyMode(settingsManager: CopyTradeSettingsManager): Promise<void> {
    console.log(chalk.cyan("\nAvailable Buy Modes:"));
    console.log(chalk.white("1. Fixed Amount"));
    console.log(chalk.white("2. Mirror Original"));
    console.log(chalk.white("3. Percentage of Original"));

    const choice = await new Promise<string>(resolve => {
        rl.question(chalk.cyan('\nSelect buy mode: '), resolve);
    });

    switch (choice) {
        case "1":
            settingsManager.updateSettings({ buyMode: BuyMode.FIXED });
            break;
        case "2":
            settingsManager.updateSettings({ buyMode: BuyMode.MIRROR });
            break;
        case "3":
            settingsManager.updateSettings({ buyMode: BuyMode.PERCENTAGE });
            break;
        default:
            console.log(chalk.red("Invalid option"));
    }
}

async function setFixedBuyAmount(settingsManager: CopyTradeSettingsManager): Promise<void> {
    const amount = await new Promise<string>(resolve => {
        rl.question(chalk.cyan('\nEnter fixed buy amount in SOL: '), resolve);
    });

    const parsedAmount = parseFloat(amount);
    if (isNaN(parsedAmount) || parsedAmount <= 0) {
        console.log(chalk.red("Invalid amount"));
        return;
    }

    settingsManager.updateSettings({ fixedBuyAmount: parsedAmount });
}

async function setMirrorPercentage(settingsManager: CopyTradeSettingsManager): Promise<void> {
    const percentage = await new Promise<string>(resolve => {
        rl.question(chalk.cyan('\nEnter percentage (1-100): '), resolve);
    });

    const parsedPercentage = parseFloat(percentage);
    if (isNaN(parsedPercentage) || parsedPercentage <= 0 || parsedPercentage > 100) {
        console.log(chalk.red("Invalid percentage"));
        return;
    }

    settingsManager.updateSettings({ mirrorPercentage: parsedPercentage });
}

async function setMinBuyAmount(settingsManager: CopyTradeSettingsManager): Promise<void> {
    const amount = await new Promise<string>(resolve => {
        rl.question(chalk.cyan('\nEnter minimum buy amount in SOL: '), resolve);
    });

    const parsedAmount = parseFloat(amount);
    if (isNaN(parsedAmount) || parsedAmount < 0) {
        console.log(chalk.red("Invalid amount"));
        return;
    }

    settingsManager.updateSettings({ minBuyAmount: parsedAmount });
}

async function setMaxBuyAmount(settingsManager: CopyTradeSettingsManager): Promise<void> {
    const amount = await new Promise<string>(resolve => {
        rl.question(chalk.cyan('\nEnter maximum buy amount in SOL: '), resolve);
    });

    const parsedAmount = parseFloat(amount);
    if (isNaN(parsedAmount) || parsedAmount <= 0) {
        console.log(chalk.red("Invalid amount"));
        return;
    }

    settingsManager.updateSettings({ maxBuyAmount: parsedAmount });
}

async function setSlippageTolerance(settingsManager: CopyTradeSettingsManager): Promise<void> {
    const percentage = await new Promise<string>(resolve => {
        rl.question(chalk.cyan('\nEnter slippage tolerance percentage (0.1-100): '), resolve);
    });

    const parsedPercentage = parseFloat(percentage);
    if (isNaN(parsedPercentage) || parsedPercentage <= 0 || parsedPercentage > 100) {
        console.log(chalk.red("Invalid percentage"));
        return;
    }

    settingsManager.updateSettings({ slippageTolerance: parsedPercentage });
}

async function toggleProtocols(settingsManager: CopyTradeSettingsManager): Promise<void> {
    const settings = settingsManager.getSettings();
    
    console.log(chalk.cyan("\nToggle Protocols:"));
    console.log(chalk.white(`1. Pump.fun (${settings.enabled.pump ? 'Enabled' : 'Disabled'})`));
    console.log(chalk.white(`2. Raydium (${settings.enabled.raydium ? 'Enabled' : 'Disabled'})`));

    const choice = await new Promise<string>(resolve => {
        rl.question(chalk.cyan('\nSelect protocol to toggle: '), resolve);
    });

    switch (choice) {
        case "1":
            settingsManager.updateSettings({
                enabled: { ...settings.enabled, pump: !settings.enabled.pump }
            });
            break;
        case "2":
            settingsManager.updateSettings({
                enabled: { ...settings.enabled, raydium: !settings.enabled.raydium }
            });
            break;
        default:
            console.log(chalk.red("Invalid option"));
    }
}