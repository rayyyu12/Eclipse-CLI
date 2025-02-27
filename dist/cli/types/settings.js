"use strict";
// src/cli/types/settings.ts
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_SETTINGS = void 0;
exports.DEFAULT_SETTINGS = {
    fees: {
        useAutomaticJitoTip: true,
        jitoTipAggressiveness: 'medium',
        useAutomaticPriorityFee: true
    },
    trade: {
        buySlippage: 0.5, // 0.5% default buy slippage
        sellSlippage: 1.0 // 1.0% default sell slippage
    },
    connection: {}, // Empty since managed by CredentialsManager
    notifications: {
        enableDiscordWebhook: false,
        notifyOnTrades: true,
        notifyOnErrors: true
    }
};
