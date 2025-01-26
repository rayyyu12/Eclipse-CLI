// src/cli/handlers/copyTradeSettingsHandler.ts

import chalk from 'chalk';
import { rl } from '../utils/formatting';
import { BuyMode, CopyTradeSettingsManager } from '../utils/copyTradingSettings';
import { COLORS } from '../config';

export async function handleCopyTradeSettings(): Promise<void> {
    const settingsManager = CopyTradeSettingsManager.getInstance();
    
    while (true) {
        console.clear();
        const header = "Copy Trading Settings";
        const divider = "—".repeat(30);
        
        console.log(chalk.hex(COLORS.PRIMARY)(`\n${header}`));
        console.log(chalk.hex(COLORS.SECONDARY)(divider));

        const settings = settingsManager.getSettings();

        // Display current settings
        console.log(chalk.hex(COLORS.PRIMARY)("\nBuy Settings:"));
        console.log(chalk.hex(COLORS.ACCENT)(`Buy Mode: ${settings.buyMode}`));
        console.log(chalk.hex(COLORS.ACCENT)(`Fixed Buy Amount: ${settings.fixedBuyAmount} SOL`));

        console.log(chalk.hex(COLORS.PRIMARY)("\nFilters:"));
        console.log(chalk.hex(COLORS.ACCENT)(`Min Buy Amount: ${settings.minBuyAmount} SOL`));
        console.log(chalk.hex(COLORS.ACCENT)(`Max Buy Amount: ${settings.maxBuyAmount} SOL`));

        console.log(chalk.hex(COLORS.PRIMARY)("\nSlippage Tolerance:"));
        console.log(chalk.hex(COLORS.ACCENT)(`Pump.fun: ${settings.slippageTolerance.pump}%`));
        console.log(chalk.hex(COLORS.ACCENT)(`Raydium: ${settings.slippageTolerance.raydium}%`));

        console.log(chalk.hex(COLORS.PRIMARY)("\nEnabled Protocols:"));
        console.log(chalk.hex(COLORS.ACCENT)(`Pump.fun: ${settings.enabled.pump ? 'Yes' : 'No'}`));
        console.log(chalk.hex(COLORS.ACCENT)(`Raydium: ${settings.enabled.raydium ? 'Yes' : 'No'}`));

        console.log(chalk.hex(COLORS.ACCENT)("\n1. Change Buy Mode"));
        console.log(chalk.hex(COLORS.ACCENT)("2. Set Fixed Buy Amount"));
        // Remove line: console.log(chalk.white("3. Set Mirror Percentage"));
        console.log(chalk.hex(COLORS.ACCENT)("3. Set Min Buy Amount")); // Update number
        console.log(chalk.hex(COLORS.ACCENT)("4. Set Max Buy Amount")); // Update number
        console.log(chalk.hex(COLORS.ACCENT)("5. Set Slippage Tolerance")); // Update number
        console.log(chalk.hex(COLORS.ACCENT)("6. Toggle Protocols")); // Update number
        console.log(chalk.hex(COLORS.ACCENT)("7. Back to Copy Trading Menu")); // Update number
        
        const choice = await new Promise<string>(resolve => {
            rl.question(chalk.hex(COLORS.PRIMARY)('\nSelect an option: '), resolve);
        });

        switch (choice) {
            case "1":
                await changeBuyMode(settingsManager);
                break;
            case "2":
                await setFixedBuyAmount(settingsManager);
                break;
            case "3":
                await setMinBuyAmount(settingsManager);
                break;
            case "4":
                await setMaxBuyAmount(settingsManager);
                break;
            case "5":
                await setSlippageTolerance(settingsManager);
                break;
            case "6":
                await toggleProtocols(settingsManager);
                break;
            case "7":
                return;
            default:
                console.log(chalk.hex(COLORS.ERROR)("Invalid option"));
        }

        if (choice !== "7") {
            await new Promise<void>(resolve => {
                rl.question(chalk.hex(COLORS.SECONDARY)('\nPress Enter to continue...'), () => resolve());
            });
        }
    }
}

async function changeBuyMode(settingsManager: CopyTradeSettingsManager): Promise<void> {
    console.log(chalk.hex(COLORS.PRIMARY)("\nAvailable Buy Modes:"));
    console.log(chalk.hex(COLORS.ACCENT)("1. Fixed Amount"));
    console.log(chalk.hex(COLORS.ACCENT)("2. Mirror Original"));

    const choice = await new Promise<string>(resolve => {
        rl.question(chalk.hex(COLORS.PRIMARY)('\nSelect buy mode: '), resolve);
    });

    switch (choice) {
        case "1":
            settingsManager.updateSettings({ buyMode: BuyMode.FIXED });
            break;
        case "2":
            settingsManager.updateSettings({ buyMode: BuyMode.MIRROR });
            break;
        default:
            console.log(chalk.hex(COLORS.ERROR)("Invalid option"));
    }
}

async function setFixedBuyAmount(settingsManager: CopyTradeSettingsManager): Promise<void> {
    const amount = await new Promise<string>(resolve => {
        rl.question(chalk.hex(COLORS.PRIMARY)('\nEnter fixed buy amount in SOL: '), resolve);
    });

    const parsedAmount = parseFloat(amount);
    if (isNaN(parsedAmount) || parsedAmount <= 0) {
        console.log(chalk.hex(COLORS.ERROR)("Invalid amount"));
        return;
    }

    settingsManager.updateSettings({ fixedBuyAmount: parsedAmount });
}

async function setMinBuyAmount(settingsManager: CopyTradeSettingsManager): Promise<void> {
    const amount = await new Promise<string>(resolve => {
        rl.question(chalk.hex(COLORS.PRIMARY)('\nEnter minimum buy amount in SOL: '), resolve);
    });

    const parsedAmount = parseFloat(amount);
    if (isNaN(parsedAmount) || parsedAmount < 0) {
        console.log(chalk.hex(COLORS.ERROR)("Invalid amount"));
        return;
    }

    settingsManager.updateSettings({ minBuyAmount: parsedAmount });
}

async function setMaxBuyAmount(settingsManager: CopyTradeSettingsManager): Promise<void> {
    const amount = await new Promise<string>(resolve => {
        rl.question(chalk.hex(COLORS.PRIMARY)('\nEnter maximum buy amount in SOL: '), resolve);
    });

    const parsedAmount = parseFloat(amount);
    if (isNaN(parsedAmount) || parsedAmount <= 0) {
        console.log(chalk.hex(COLORS.ERROR)("Invalid amount"));
        return;
    }

    settingsManager.updateSettings({ maxBuyAmount: parsedAmount });
}

// Update the setSlippageTolerance function in copyTradeSettingsHandler.ts

async function setSlippageTolerance(settingsManager: CopyTradeSettingsManager): Promise<void> {
    console.log(chalk.hex(COLORS.PRIMARY)("\nSet Slippage Tolerance:"));
    console.log(chalk.hex(COLORS.ACCENT)("1. Set Pump.fun Slippage"));
    console.log(chalk.hex(COLORS.ACCENT)("2. Set Raydium Slippage"));
    
    const choice = await new Promise<string>(resolve => {
        rl.question(chalk.hex(COLORS.PRIMARY)('\nSelect option: '), resolve);
    });

    const percentage = await new Promise<string>(resolve => {
        rl.question(chalk.hex(COLORS.PRIMARY)('\nEnter slippage tolerance percentage (0.1-100): '), resolve);
    });

    const parsedPercentage = parseFloat(percentage);
    if (isNaN(parsedPercentage) || parsedPercentage <= 0 || parsedPercentage > 100) {
        console.log(chalk.hex(COLORS.ERROR)("Invalid percentage"));
        return;
    }

    const currentSettings = settingsManager.getSettings();
    
    switch (choice) {
        case "1":
            settingsManager.updateSettings({
                slippageTolerance: {
                    ...currentSettings.slippageTolerance,
                    pump: parsedPercentage
                }
            });
            console.log(chalk.hex(COLORS.SUCCESS)(`Pump.fun slippage set to ${parsedPercentage}%`));
            break;
        case "2":
            settingsManager.updateSettings({
                slippageTolerance: {
                    ...currentSettings.slippageTolerance,
                    raydium: parsedPercentage
                }
            });
            console.log(chalk.hex(COLORS.SUCCESS)(`Raydium slippage set to ${parsedPercentage}%`));
            break;
        default:
            console.log(chalk.hex(COLORS.ERROR)("Invalid option"));
    }
}

async function toggleProtocols(settingsManager: CopyTradeSettingsManager): Promise<void> {
    const settings = settingsManager.getSettings();
    
    console.log(chalk.hex(COLORS.PRIMARY)("\nToggle Protocols:"));
    console.log(chalk.hex(COLORS.ACCENT)(`1. Pump.fun (${settings.enabled.pump ? 'Enabled' : 'Disabled'})`));
    console.log(chalk.hex(COLORS.ACCENT)(`2. Raydium (${settings.enabled.raydium ? 'Enabled' : 'Disabled'})`));

    const choice = await new Promise<string>(resolve => {
        rl.question(chalk.hex(COLORS.PRIMARY)('\nSelect protocol to toggle: '), resolve);
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
            console.log(chalk.hex(COLORS.ERROR)("Invalid option"));
    }
}