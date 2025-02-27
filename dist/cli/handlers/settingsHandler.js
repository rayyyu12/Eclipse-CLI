"use strict";
// src/cli/handlers/settingsHandler.ts
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleSettings = handleSettings;
const chalk_1 = __importDefault(require("chalk"));
const settingsManager_1 = require("../utils/settingsManager");
const credentialsManager_1 = require("../utils/credentialsManager");
const formatting_1 = require("../utils/formatting");
const config_1 = require("../config");
async function handleSettings() {
    const settingsManager = settingsManager_1.SettingsManager.getInstance();
    const credManager = credentialsManager_1.CredentialsManager.getInstance();
    let running = true;
    while (running) {
        console.clear();
        const settings = settingsManager.getSettings();
        console.log(chalk_1.default.hex(config_1.COLORS.PRIMARY)('\nSettings Menu'));
        console.log(chalk_1.default.hex(config_1.COLORS.SECONDARY)('—'.repeat(50)));
        // Fee Settings Display
        console.log(chalk_1.default.hex(config_1.COLORS.PRIMARY)('\nFee Settings:'));
        console.log(`1. Jito Tip Mode: ${settings.fees.useAutomaticJitoTip ? 'Automatic' : 'Fixed'}`);
        if (!settings.fees.useAutomaticJitoTip && settings.fees.fixedJitoTipAmount) {
            console.log(`   Fixed Amount: ${settings.fees.fixedJitoTipAmount} SOL`);
        }
        console.log(`2. Priority Fee Mode: ${settings.fees.useAutomaticPriorityFee ? 'Automatic' : 'Fixed'}`);
        if (!settings.fees.useAutomaticPriorityFee && settings.fees.fixedPriorityFee) {
            console.log(`   Fixed Amount: ${settings.fees.fixedPriorityFee} microLamports`);
        }
        console.log(`3. Jito Tip Aggressiveness: ${settings.fees.jitoTipAggressiveness}`);
        // Trade Settings Display
        console.log(chalk_1.default.hex(config_1.COLORS.PRIMARY)('\nTrade Settings:'));
        console.log(`4. Buy Slippage: ${settings.trade.buySlippage}%`);
        console.log(`5. Sell Slippage: ${settings.trade.sellSlippage}%`);
        // Connection Settings Display
        console.log(chalk_1.default.hex(config_1.COLORS.PRIMARY)('\nConnection Settings:'));
        try {
            const rpcUrl = credManager.getRpcUrl();
            console.log(`6. RPC URL: ${rpcUrl.substring(0, 20)}...`);
        }
        catch {
            console.log('6. RPC URL: Not configured');
        }
        try {
            credManager.getPrivateKey();
            console.log('7. Private Key: Configured');
        }
        catch {
            console.log('7. Private Key: Not configured');
        }
        try {
            const grpcUrl = credManager.getGrpcUrl();
            console.log(`8. GRPC URL: ${grpcUrl.substring(0, 20)}...`);
        }
        catch {
            console.log('8. GRPC URL: Not configured');
        }
        try {
            credManager.getAuthToken();
            console.log('9. Auth Token: Configured');
        }
        catch {
            console.log('9. Auth Token: Not configured');
        }
        try {
            const wsEndpoint = credManager.getWsEndpoint();
            console.log(`10. WebSocket URL: ${wsEndpoint.substring(0, 20)}...`);
        }
        catch {
            console.log('10. WebSocket URL: Not configured');
        }
        // Notification Settings Display
        console.log(chalk_1.default.hex(config_1.COLORS.PRIMARY)('\nNotification Settings:'));
        console.log(`11. Discord Webhook: ${settings.notifications.enableDiscordWebhook ? 'Enabled' : 'Disabled'}`);
        if (settings.notifications.enableDiscordWebhook) {
            console.log(`    URL: ${settings.notifications.discordWebhookUrl ? '********' : 'Not set'}`);
        }
        console.log(`12. Trade Notifications: ${settings.notifications.notifyOnTrades ? 'Enabled' : 'Disabled'}`);
        console.log(`13. Error Notifications: ${settings.notifications.notifyOnErrors ? 'Enabled' : 'Disabled'}`);
        console.log(chalk_1.default.hex(config_1.COLORS.SECONDARY)('\n14. Return to Main Menu'));
        console.log(chalk_1.default.hex(config_1.COLORS.SECONDARY)('—'.repeat(50)));
        const choice = await (0, formatting_1.promptWithValidation)('Select an option: ', (input) => ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13', '14'].includes(input), 'Invalid option. Please try again.');
        switch (choice) {
            case '1':
                await handleJitoTipSettings();
                break;
            case '2':
                await handlePriorityFeeSettings();
                break;
            case '3':
                await handleJitoAggressivenessSettings();
                break;
            case '4':
                await handleBuySlippageSettings(settingsManager);
                break;
            case '5':
                await handleSellSlippageSettings(settingsManager);
                break;
            case '6':
                await handleRpcUrlSettings();
                break;
            case '7':
                await handlePrivateKeySettings();
                break;
            case '8':
                await handleGrpcUrlSettings();
                break;
            case '9':
                await handleAuthTokenSettings();
                break;
            case '10':
                await handleWebSocketSettings();
                break;
            case '11':
                await handleDiscordWebhookSettings(settingsManager);
                break;
            case '12':
                await handleTradeNotificationSettings(settingsManager);
                break;
            case '13':
                await handleErrorNotificationSettings(settingsManager);
                break;
            case '14':
                running = false;
                break;
        }
    }
}
async function handleJitoTipSettings() {
    const settingsManager = settingsManager_1.SettingsManager.getInstance();
    const useAutomatic = await (0, formatting_1.promptWithValidation)('Use automatic Jito tip calculation? (y/n): ', (input) => ['y', 'n'].includes(input.toLowerCase()), 'Please enter y or n.');
    if (useAutomatic.toLowerCase() === 'n') {
        const amount = await (0, formatting_1.promptWithValidation)('Enter fixed Jito tip amount in SOL: ', (input) => !isNaN(parseFloat(input)) && parseFloat(input) > 0, 'Please enter a valid number greater than 0.');
        settingsManager.updateFeeSettings({
            useAutomaticJitoTip: false,
            fixedJitoTipAmount: parseFloat(amount)
        });
    }
    else {
        settingsManager.updateFeeSettings({
            useAutomaticJitoTip: true,
            fixedJitoTipAmount: undefined
        });
    }
}
async function handleJitoAggressivenessSettings() {
    const settingsManager = settingsManager_1.SettingsManager.getInstance();
    console.log('\nSelect Jito tip aggressiveness:');
    console.log('1. Low (25th percentile)');
    console.log('2. Medium (75th percentile)');
    console.log('3. High (95th percentile)');
    const choice = await (0, formatting_1.promptWithValidation)('Enter your choice (1-3): ', (input) => ['1', '2', '3'].includes(input), 'Please enter a number between 1 and 3.');
    const aggressivenessMap = {
        '1': 'low',
        '2': 'medium',
        '3': 'high'
    };
    settingsManager.updateFeeSettings({
        jitoTipAggressiveness: aggressivenessMap[choice]
    });
}
async function handlePriorityFeeSettings() {
    const settingsManager = settingsManager_1.SettingsManager.getInstance();
    const useAutomatic = await (0, formatting_1.promptWithValidation)('Use automatic priority fee calculation? (y/n): ', (input) => ['y', 'n'].includes(input.toLowerCase()), 'Please enter y or n.');
    if (useAutomatic.toLowerCase() === 'n') {
        console.log(chalk_1.default.yellow('\nNote: Priority fee is in microLamports per compute unit'));
        console.log(chalk_1.default.yellow('Recommended range: 1 - 1,000,000,000'));
        console.log(chalk_1.default.yellow('Examples:'));
        console.log(chalk_1.default.yellow('  100,000 = Standard priority'));
        console.log(chalk_1.default.yellow('  500,000 = High priority'));
        console.log(chalk_1.default.yellow('  1,000,000 = Very high priority'));
        console.log(chalk_1.default.yellow('  5,000,000 = Extreme priority'));
        console.log(chalk_1.default.yellow('  50,000,000+ = Ultra priority (use with caution)'));
        console.log(chalk_1.default.hex(config_1.COLORS.ERROR)('\nWarning: Higher fees will increase transaction costs significantly!'));
        const amount = await (0, formatting_1.promptWithValidation)('Enter fixed priority fee in microLamports/cu: ', (input) => {
            const value = parseInt(input);
            return !isNaN(value) && value > 0 && value <= 1000000000;
        }, 'Please enter a valid number between 1 and 1,000,000,000.');
        settingsManager.updateFeeSettings({
            useAutomaticPriorityFee: false,
            fixedPriorityFee: parseInt(amount)
        });
        // Add warning for high fees
        if (parseInt(amount) > 1000000) {
            console.log(chalk_1.default.hex(config_1.COLORS.ERROR)(`\nWarning: You've set a very high priority fee of ${amount} microLamports/cu`));
            console.log(chalk_1.default.hex(config_1.COLORS.ERROR)('This will significantly increase your transaction costs!'));
        }
        console.log(chalk_1.default.hex(config_1.COLORS.SUCCESS)(`\nPriority fee set to ${amount} microLamports/cu`));
    }
    else {
        settingsManager.updateFeeSettings({
            useAutomaticPriorityFee: true,
            fixedPriorityFee: undefined
        });
        console.log(chalk_1.default.hex(config_1.COLORS.SUCCESS)('Automatic priority fee calculation enabled'));
    }
}
async function handleRpcUrlSettings() {
    const credManager = credentialsManager_1.CredentialsManager.getInstance();
    console.log(chalk_1.default.hex(config_1.COLORS.PRIMARY)('\nRPC URL Settings'));
    console.log(chalk_1.default.hex(config_1.COLORS.SECONDARY)('—'.repeat(50)));
    try {
        const currentUrl = credManager.getRpcUrl();
        console.log(`Current RPC URL: ${currentUrl.substring(0, 20)}...`);
    }
    catch {
        console.log(chalk_1.default.yellow('No RPC URL currently configured'));
    }
    const updateUrl = await (0, formatting_1.promptWithValidation)('Would you like to update the RPC URL? (y/n): ', (input) => ['y', 'n'].includes(input.toLowerCase()), 'Please enter y or n.');
    if (updateUrl.toLowerCase() === 'y') {
        const newUrl = await (0, formatting_1.promptWithValidation)('Enter new RPC URL: ', (input) => {
            try {
                new URL(input);
                return true;
            }
            catch {
                return false;
            }
        }, 'Please enter a valid URL.');
        console.log(chalk_1.default.yellow('\nTesting RPC connection...'));
        try {
            await credManager.setRpcUrl(newUrl);
            // Verify the update by reading it back
            const verifyUrl = credManager.getRpcUrl();
            console.log(chalk_1.default.blue('Stored RPC URL:', verifyUrl));
            if (verifyUrl === newUrl) {
                console.log(chalk_1.default.hex(config_1.COLORS.SUCCESS)('RPC URL updated and verified successfully!'));
            }
            else {
                console.log(chalk_1.default.hex(config_1.COLORS.ERROR)('RPC URL verification failed - stored URL does not match input'));
            }
        }
        catch (error) {
            if (error instanceof Error) {
                console.log(chalk_1.default.hex(config_1.COLORS.ERROR)('Failed to update RPC URL:', error.message));
            }
            else {
                console.log(chalk_1.default.hex(config_1.COLORS.ERROR)('Failed to update RPC URL: Unknown error'));
            }
        }
    }
}
async function handlePrivateKeySettings() {
    const credManager = credentialsManager_1.CredentialsManager.getInstance();
    console.log(chalk_1.default.hex(config_1.COLORS.PRIMARY)('\nPrivate Key Settings'));
    console.log(chalk_1.default.hex(config_1.COLORS.SECONDARY)('—'.repeat(50)));
    try {
        credManager.getPrivateKey();
        console.log('Current Status: Private key is set');
    }
    catch {
        console.log(chalk_1.default.yellow('No private key currently configured'));
    }
    const updateKey = await (0, formatting_1.promptWithValidation)('Would you like to update the private key? (y/n): ', (input) => ['y', 'n'].includes(input.toLowerCase()), 'Please enter y or n.');
    if (updateKey.toLowerCase() === 'y') {
        console.log(chalk_1.default.yellow('\nNote: Please enter your private key in base58 format'));
        const newKey = await (0, formatting_1.promptWithValidation)('Enter private key: ', (input) => /^[1-9A-HJ-NP-Za-km-z]{87,88}$/.test(input), 'Please enter a valid base58 private key.');
        try {
            await credManager.setPrivateKey(newKey);
            console.log(chalk_1.default.hex(config_1.COLORS.SUCCESS)('Private key updated successfully!'));
        }
        catch (error) {
            if (error instanceof Error) {
                console.log(chalk_1.default.hex(config_1.COLORS.ERROR)('Failed to update private key:', error.message));
            }
            else {
                console.log(chalk_1.default.hex(config_1.COLORS.ERROR)('Failed to update private key: Unknown error'));
            }
        }
    }
}
async function handleGrpcUrlSettings() {
    const credManager = credentialsManager_1.CredentialsManager.getInstance();
    console.log(chalk_1.default.hex(config_1.COLORS.PRIMARY)('\nGRPC URL Settings'));
    console.log(chalk_1.default.hex(config_1.COLORS.SECONDARY)('—'.repeat(50)));
    try {
        const currentUrl = credManager.getGrpcUrl();
        console.log(`Current GRPC URL: ${currentUrl.substring(0, 20)}...`);
    }
    catch {
        console.log(chalk_1.default.yellow('No GRPC URL currently configured'));
    }
    const updateUrl = await (0, formatting_1.promptWithValidation)('Would you like to update the GRPC URL? (y/n): ', (input) => ['y', 'n'].includes(input.toLowerCase()), 'Please enter y or n.');
    if (updateUrl.toLowerCase() === 'y') {
        const newUrl = await (0, formatting_1.promptWithValidation)('Enter new GRPC URL: ', (input) => {
            try {
                new URL(input);
                return true;
            }
            catch {
                return false;
            }
        }, 'Please enter a valid URL.');
        console.log(chalk_1.default.yellow('\nTesting GRPC connection...'));
        try {
            await credManager.setGrpcUrl(newUrl);
            console.log(chalk_1.default.hex(config_1.COLORS.SUCCESS)('GRPC URL updated and verified successfully!'));
        }
        catch (error) {
            if (error instanceof Error) {
                console.log(chalk_1.default.hex(config_1.COLORS.ERROR)('Failed to update GRPC URL:', error.message));
            }
            else {
                console.log(chalk_1.default.hex(config_1.COLORS.ERROR)('Failed to update GRPC URL: Unknown error'));
            }
        }
    }
}
async function handleAuthTokenSettings() {
    const credManager = credentialsManager_1.CredentialsManager.getInstance();
    console.log(chalk_1.default.hex(config_1.COLORS.PRIMARY)('\nAuth Token Settings'));
    console.log(chalk_1.default.hex(config_1.COLORS.SECONDARY)('—'.repeat(50)));
    try {
        credManager.getAuthToken();
        console.log('Current Status: Auth token is set');
    }
    catch {
        console.log(chalk_1.default.yellow('No auth token currently configured'));
    }
    const updateToken = await (0, formatting_1.promptWithValidation)('Would you like to update the auth token? (y/n): ', (input) => ['y', 'n'].includes(input.toLowerCase()), 'Please enter y or n.');
    if (updateToken.toLowerCase() === 'y') {
        const newToken = await (0, formatting_1.promptWithValidation)('Enter auth token: ', (input) => input.length > 0, 'Please enter a valid auth token.');
        try {
            await credManager.setAuthToken(newToken);
            console.log(chalk_1.default.hex(config_1.COLORS.SUCCESS)('Auth token updated successfully!'));
        }
        catch (error) {
            if (error instanceof Error) {
                console.log(chalk_1.default.hex(config_1.COLORS.ERROR)('Failed to update auth token:', error.message));
            }
            else {
                console.log(chalk_1.default.hex(config_1.COLORS.ERROR)('Failed to update auth token: Unknown error'));
            }
        }
    }
}
async function handleWebSocketSettings() {
    const credManager = credentialsManager_1.CredentialsManager.getInstance();
    console.log(chalk_1.default.hex(config_1.COLORS.PRIMARY)('\nWebSocket URL Settings'));
    console.log(chalk_1.default.hex(config_1.COLORS.SECONDARY)('—'.repeat(50)));
    try {
        const currentUrl = credManager.getWsEndpoint();
        console.log(`Current WebSocket URL: ${currentUrl.substring(0, 20)}...`);
    }
    catch {
        console.log(chalk_1.default.yellow('No WebSocket URL currently configured'));
    }
    const updateUrl = await (0, formatting_1.promptWithValidation)('Would you like to update the WebSocket URL? (y/n): ', (input) => ['y', 'n'].includes(input.toLowerCase()), 'Please enter y or n.');
    if (updateUrl.toLowerCase() === 'y') {
        const newUrl = await (0, formatting_1.promptWithValidation)('Enter new WebSocket URL (ws:// or wss://): ', (input) => {
            try {
                if (!input.startsWith('ws://') && !input.startsWith('wss://')) {
                    return false;
                }
                new URL(input);
                return true;
            }
            catch {
                return false;
            }
        }, 'Please enter a valid WebSocket URL (must start with ws:// or wss://).');
        try {
            await credManager.setWsEndpoint(newUrl);
            console.log(chalk_1.default.hex(config_1.COLORS.SUCCESS)('WebSocket URL updated successfully!'));
        }
        catch (error) {
            if (error instanceof Error) {
                console.log(chalk_1.default.hex(config_1.COLORS.ERROR)('Failed to update WebSocket URL:', error.message));
            }
            else {
                console.log(chalk_1.default.hex(config_1.COLORS.ERROR)('Failed to update WebSocket URL: Unknown error'));
            }
        }
    }
}
async function handleDiscordWebhookSettings(settingsManager) {
    console.log(chalk_1.default.yellow('Discord webhook settings coming soon...'));
    await new Promise(resolve => setTimeout(resolve, 1500));
}
async function handleTradeNotificationSettings(settingsManager) {
    console.log(chalk_1.default.yellow('Trade notification settings coming soon...'));
    await new Promise(resolve => setTimeout(resolve, 1500));
}
async function handleErrorNotificationSettings(settingsManager) {
    console.log(chalk_1.default.yellow('Error notification settings coming soon...'));
    await new Promise(resolve => setTimeout(resolve, 1500));
}
async function handleBuySlippageSettings(settingsManager) {
    console.log(chalk_1.default.hex(config_1.COLORS.PRIMARY)('\nBuy Slippage Settings'));
    console.log(chalk_1.default.hex(config_1.COLORS.SECONDARY)('—'.repeat(50)));
    const currentSettings = settingsManager.getSettings();
    console.log(`Current buy slippage: ${currentSettings.trade.buySlippage}%`);
    const newSlippage = await (0, formatting_1.promptWithValidation)('Enter new buy slippage percentage: ', (input) => {
        const value = parseFloat(input);
        return !isNaN(value) && value > 0;
    }, 'Please enter a valid positive number.');
    settingsManager.updateSettings({
        trade: {
            ...currentSettings.trade,
            buySlippage: parseFloat(newSlippage)
        }
    });
    console.log(chalk_1.default.hex(config_1.COLORS.SUCCESS)(`\nBuy slippage updated to ${newSlippage}%`));
}
async function handleSellSlippageSettings(settingsManager) {
    console.log(chalk_1.default.hex(config_1.COLORS.PRIMARY)('\nSell Slippage Settings'));
    console.log(chalk_1.default.hex(config_1.COLORS.SECONDARY)('—'.repeat(50)));
    const currentSettings = settingsManager.getSettings();
    console.log(`Current sell slippage: ${currentSettings.trade.sellSlippage}%`);
    const newSlippage = await (0, formatting_1.promptWithValidation)('Enter new sell slippage percentage: ', (input) => {
        const value = parseFloat(input);
        return !isNaN(value) && value > 0;
    }, 'Please enter a valid positive number.');
    settingsManager.updateSettings({
        trade: {
            ...currentSettings.trade,
            sellSlippage: parseFloat(newSlippage)
        }
    });
    console.log(chalk_1.default.hex(config_1.COLORS.SUCCESS)(`\nSell slippage updated to ${newSlippage}%`));
}
