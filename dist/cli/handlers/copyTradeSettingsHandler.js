"use strict";
// src/cli/handlers/copyTradeSettingsHandler.ts
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleCopyTradeSettings = handleCopyTradeSettings;
const chalk_1 = __importDefault(require("chalk"));
const formatting_1 = require("../utils/formatting");
const copyTradingSettings_1 = require("../utils/copyTradingSettings");
const config_1 = require("../config");
async function handleCopyTradeSettings() {
    const settingsManager = copyTradingSettings_1.CopyTradeSettingsManager.getInstance();
    while (true) {
        console.clear();
        const header = "Copy Trading Settings";
        const divider = "—".repeat(30);
        console.log(chalk_1.default.hex(config_1.COLORS.PRIMARY)(`\n${header}`));
        console.log(chalk_1.default.hex(config_1.COLORS.SECONDARY)(divider));
        const settings = settingsManager.getSettings();
        // Display current settings
        console.log(chalk_1.default.hex(config_1.COLORS.PRIMARY)("\nBuy Settings:"));
        console.log(chalk_1.default.hex(config_1.COLORS.ACCENT)(`Buy Mode: ${settings.buyMode}`));
        console.log(chalk_1.default.hex(config_1.COLORS.ACCENT)(`Fixed Buy Amount: ${settings.fixedBuyAmount} SOL`));
        console.log(chalk_1.default.hex(config_1.COLORS.PRIMARY)("\nFilters:"));
        console.log(chalk_1.default.hex(config_1.COLORS.ACCENT)(`Min Buy Amount: ${settings.minBuyAmount} SOL`));
        console.log(chalk_1.default.hex(config_1.COLORS.ACCENT)(`Max Buy Amount: ${settings.maxBuyAmount} SOL`));
        console.log(chalk_1.default.hex(config_1.COLORS.PRIMARY)("\nSlippage Tolerance:"));
        console.log(chalk_1.default.hex(config_1.COLORS.ACCENT)(`Pump.fun: ${settings.slippageTolerance.pump}%`));
        console.log(chalk_1.default.hex(config_1.COLORS.ACCENT)(`Raydium: ${settings.slippageTolerance.raydium}%`));
        console.log(chalk_1.default.hex(config_1.COLORS.PRIMARY)("\nEnabled Protocols:"));
        console.log(chalk_1.default.hex(config_1.COLORS.ACCENT)(`Pump.fun: ${settings.enabled.pump ? 'Yes' : 'No'}`));
        console.log(chalk_1.default.hex(config_1.COLORS.ACCENT)(`Raydium: ${settings.enabled.raydium ? 'Yes' : 'No'}`));
        console.log(chalk_1.default.hex(config_1.COLORS.ACCENT)("\n1. Change Buy Mode"));
        console.log(chalk_1.default.hex(config_1.COLORS.ACCENT)("2. Set Fixed Buy Amount"));
        // Remove line: console.log(chalk.white("3. Set Mirror Percentage"));
        console.log(chalk_1.default.hex(config_1.COLORS.ACCENT)("3. Set Min Buy Amount")); // Update number
        console.log(chalk_1.default.hex(config_1.COLORS.ACCENT)("4. Set Max Buy Amount")); // Update number
        console.log(chalk_1.default.hex(config_1.COLORS.ACCENT)("5. Set Slippage Tolerance")); // Update number
        console.log(chalk_1.default.hex(config_1.COLORS.ACCENT)("6. Toggle Protocols")); // Update number
        console.log(chalk_1.default.hex(config_1.COLORS.ACCENT)("7. Back to Copy Trading Menu")); // Update number
        const choice = await new Promise(resolve => {
            formatting_1.rl.question(chalk_1.default.hex(config_1.COLORS.PRIMARY)('\nSelect an option: '), resolve);
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
                console.log(chalk_1.default.hex(config_1.COLORS.ERROR)("Invalid option"));
        }
        if (choice !== "7") {
            await new Promise(resolve => {
                formatting_1.rl.question(chalk_1.default.hex(config_1.COLORS.SECONDARY)('\nPress Enter to continue...'), () => resolve());
            });
        }
    }
}
async function changeBuyMode(settingsManager) {
    console.log(chalk_1.default.hex(config_1.COLORS.PRIMARY)("\nAvailable Buy Modes:"));
    console.log(chalk_1.default.hex(config_1.COLORS.ACCENT)("1. Fixed Amount"));
    console.log(chalk_1.default.hex(config_1.COLORS.ACCENT)("2. Mirror Original"));
    const choice = await new Promise(resolve => {
        formatting_1.rl.question(chalk_1.default.hex(config_1.COLORS.PRIMARY)('\nSelect buy mode: '), resolve);
    });
    switch (choice) {
        case "1":
            settingsManager.updateSettings({ buyMode: copyTradingSettings_1.BuyMode.FIXED });
            break;
        case "2":
            settingsManager.updateSettings({ buyMode: copyTradingSettings_1.BuyMode.MIRROR });
            break;
        default:
            console.log(chalk_1.default.hex(config_1.COLORS.ERROR)("Invalid option"));
    }
}
async function setFixedBuyAmount(settingsManager) {
    const amount = await new Promise(resolve => {
        formatting_1.rl.question(chalk_1.default.hex(config_1.COLORS.PRIMARY)('\nEnter fixed buy amount in SOL: '), resolve);
    });
    const parsedAmount = parseFloat(amount);
    if (isNaN(parsedAmount) || parsedAmount <= 0) {
        console.log(chalk_1.default.hex(config_1.COLORS.ERROR)("Invalid amount"));
        return;
    }
    settingsManager.updateSettings({ fixedBuyAmount: parsedAmount });
}
async function setMinBuyAmount(settingsManager) {
    const amount = await new Promise(resolve => {
        formatting_1.rl.question(chalk_1.default.hex(config_1.COLORS.PRIMARY)('\nEnter minimum buy amount in SOL: '), resolve);
    });
    const parsedAmount = parseFloat(amount);
    if (isNaN(parsedAmount) || parsedAmount < 0) {
        console.log(chalk_1.default.hex(config_1.COLORS.ERROR)("Invalid amount"));
        return;
    }
    settingsManager.updateSettings({ minBuyAmount: parsedAmount });
}
async function setMaxBuyAmount(settingsManager) {
    const amount = await new Promise(resolve => {
        formatting_1.rl.question(chalk_1.default.hex(config_1.COLORS.PRIMARY)('\nEnter maximum buy amount in SOL: '), resolve);
    });
    const parsedAmount = parseFloat(amount);
    if (isNaN(parsedAmount) || parsedAmount <= 0) {
        console.log(chalk_1.default.hex(config_1.COLORS.ERROR)("Invalid amount"));
        return;
    }
    settingsManager.updateSettings({ maxBuyAmount: parsedAmount });
}
// Update the setSlippageTolerance function in copyTradeSettingsHandler.ts
async function setSlippageTolerance(settingsManager) {
    console.log(chalk_1.default.hex(config_1.COLORS.PRIMARY)("\nSet Slippage Tolerance:"));
    console.log(chalk_1.default.hex(config_1.COLORS.ACCENT)("1. Set Pump.fun Slippage"));
    console.log(chalk_1.default.hex(config_1.COLORS.ACCENT)("2. Set Raydium Slippage"));
    const choice = await new Promise(resolve => {
        formatting_1.rl.question(chalk_1.default.hex(config_1.COLORS.PRIMARY)('\nSelect option: '), resolve);
    });
    const percentage = await new Promise(resolve => {
        formatting_1.rl.question(chalk_1.default.hex(config_1.COLORS.PRIMARY)('\nEnter slippage tolerance percentage (0.1-100): '), resolve);
    });
    const parsedPercentage = parseFloat(percentage);
    if (isNaN(parsedPercentage) || parsedPercentage <= 0 || parsedPercentage > 100) {
        console.log(chalk_1.default.hex(config_1.COLORS.ERROR)("Invalid percentage"));
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
            console.log(chalk_1.default.hex(config_1.COLORS.SUCCESS)(`Pump.fun slippage set to ${parsedPercentage}%`));
            break;
        case "2":
            settingsManager.updateSettings({
                slippageTolerance: {
                    ...currentSettings.slippageTolerance,
                    raydium: parsedPercentage
                }
            });
            console.log(chalk_1.default.hex(config_1.COLORS.SUCCESS)(`Raydium slippage set to ${parsedPercentage}%`));
            break;
        default:
            console.log(chalk_1.default.hex(config_1.COLORS.ERROR)("Invalid option"));
    }
}
async function toggleProtocols(settingsManager) {
    const settings = settingsManager.getSettings();
    console.log(chalk_1.default.hex(config_1.COLORS.PRIMARY)("\nToggle Protocols:"));
    console.log(chalk_1.default.hex(config_1.COLORS.ACCENT)(`1. Pump.fun (${settings.enabled.pump ? 'Enabled' : 'Disabled'})`));
    console.log(chalk_1.default.hex(config_1.COLORS.ACCENT)(`2. Raydium (${settings.enabled.raydium ? 'Enabled' : 'Disabled'})`));
    const choice = await new Promise(resolve => {
        formatting_1.rl.question(chalk_1.default.hex(config_1.COLORS.PRIMARY)('\nSelect protocol to toggle: '), resolve);
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
            console.log(chalk_1.default.hex(config_1.COLORS.ERROR)("Invalid option"));
    }
}
