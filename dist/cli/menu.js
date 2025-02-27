"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.displayMenu = displayMenu;
exports.handleMenuChoice = handleMenuChoice;
// src/cli/menu.ts
const chalk_1 = __importDefault(require("chalk"));
const config_1 = require("./config");
const formatting_1 = require("./utils/formatting");
const buyHandler_1 = require("./handlers/buyHandler");
const sellHandler_1 = require("./handlers/sellHandler");
const positionsHandler_1 = require("./handlers/positionsHandler");
const settingsHandler_1 = require("./handlers/settingsHandler");
const copyTradeHandler_1 = require("./handlers/copyTradeHandler");
const credentialsManager_1 = require("./utils/credentialsManager");
const credentialsManager = credentialsManager_1.CredentialsManager.getInstance();
async function checkRpcUrl() {
    try {
        credentialsManager.getRpcUrl();
        return true;
    }
    catch {
        console.log(chalk_1.default.hex(config_1.COLORS.ERROR)('Please set RPC URL in settings first'));
        return false;
    }
}
async function checkPrivateKey() {
    try {
        credentialsManager.getPrivateKey();
        return true;
    }
    catch {
        console.log(chalk_1.default.hex(config_1.COLORS.ERROR)('Please set private key in settings first'));
        return false;
    }
}
async function checkCopyTradeRequirements() {
    let hasRequirements = true;
    try {
        credentialsManager.getRpcUrl();
    }
    catch {
        console.log(chalk_1.default.hex(config_1.COLORS.ERROR)('Please set RPC URL in settings'));
        hasRequirements = false;
    }
    try {
        credentialsManager.getGrpcUrl();
    }
    catch {
        console.log(chalk_1.default.hex(config_1.COLORS.ERROR)('Please set GRPC URL in settings'));
        hasRequirements = false;
    }
    return hasRequirements;
}
function displayMenu() {
    console.clear();
    console.log(chalk_1.default.hex(config_1.COLORS.LOGO).bold(config_1.ASCII_BANNER));
    console.log(chalk_1.default.hex(config_1.COLORS.SECONDARY)("—".repeat(config_1.CONFIG.MENU_WIDTH)));
    console.log(chalk_1.default.white("1. ") + chalk_1.default.hex(config_1.COLORS.ACCENT)("Buy"));
    console.log(chalk_1.default.white("2. ") + chalk_1.default.hex(config_1.COLORS.ACCENT)("Sell"));
    console.log(chalk_1.default.white("3. ") + chalk_1.default.hex(config_1.COLORS.ACCENT)("Positions"));
    console.log(chalk_1.default.white("4. ") + chalk_1.default.hex(config_1.COLORS.ACCENT)("Balance"));
    console.log(chalk_1.default.white("5. ") + chalk_1.default.hex(config_1.COLORS.ACCENT)("Transfer"));
    console.log(chalk_1.default.white("6. ") + chalk_1.default.hex(config_1.COLORS.ACCENT)("Copy Trade"));
    console.log(chalk_1.default.white("7. ") + chalk_1.default.hex(config_1.COLORS.ACCENT)("Settings"));
    console.log(chalk_1.default.white("8. ") + chalk_1.default.hex(config_1.COLORS.ACCENT)("Exit"));
    console.log(chalk_1.default.hex(config_1.COLORS.SECONDARY)("—".repeat(config_1.CONFIG.MENU_WIDTH)));
}
async function handleMenuChoice(choice) {
    console.clear();
    switch (choice) {
        case config_1.CONFIG.COMMANDS.BUY:
            if (await checkRpcUrl()) {
                await (0, buyHandler_1.handleBuy)();
            }
            break;
        case config_1.CONFIG.COMMANDS.SELL:
            if (await checkRpcUrl()) {
                await (0, sellHandler_1.handleSell)();
            }
            break;
        case config_1.CONFIG.COMMANDS.POSITIONS:
            if (await checkPrivateKey()) {
                await (0, positionsHandler_1.handlePositions)();
            }
            break;
        case config_1.CONFIG.COMMANDS.BALANCE:
            if (await checkPrivateKey()) {
                console.log(chalk_1.default.yellow("Balance feature coming soon..."));
            }
            break;
        case config_1.CONFIG.COMMANDS.TRANSFER:
            if (await checkPrivateKey()) {
                console.log(chalk_1.default.yellow("Transfer feature coming soon..."));
            }
            break;
        case config_1.CONFIG.COMMANDS.COPY_TRADE:
            if (await checkCopyTradeRequirements()) {
                await (0, copyTradeHandler_1.handleCopyTrade)();
            }
            break;
        case config_1.CONFIG.COMMANDS.SETTINGS:
            await (0, settingsHandler_1.handleSettings)();
            break;
        case config_1.CONFIG.COMMANDS.EXIT:
            console.log(chalk_1.default.hex(config_1.COLORS.SUCCESS)("Goodbye!"));
            return false;
        default:
            console.log(chalk_1.default.red("Invalid option"));
    }
    await new Promise(resolve => {
        formatting_1.rl.question(chalk_1.default.hex(config_1.COLORS.SECONDARY)('\nPress Enter to continue...'), () => resolve());
    });
    return true;
}
