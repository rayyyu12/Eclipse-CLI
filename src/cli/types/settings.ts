// src/cli/types/settings.ts

export interface FeeSettings {
    useAutomaticJitoTip: boolean;
    fixedJitoTipAmount?: number;  // in SOL
    useAutomaticPriorityFee: boolean;
    fixedPriorityFee?: number;    // in microLamports
    jitoTipAggressiveness: 'low' | 'medium' | 'high';
}

export interface TradeSettings {
    buySlippage: number;     // percentage (0-100)
    sellSlippage: number;    // percentage (0-100)
}

export interface ConnectionSettings {
    rpcUrl?: string;
    privateKey?: string;
    grpcUrl?: string;
    authToken?: string;
    wsEndpoint?: string;
}

export interface NotificationSettings {
    enableDiscordWebhook: boolean;
    discordWebhookUrl?: string;
    notifyOnTrades: boolean;
    notifyOnErrors: boolean;
}

export interface Settings {
    fees: FeeSettings;
    trade: TradeSettings;
    connection: ConnectionSettings;
    notifications: NotificationSettings;
}

export const DEFAULT_SETTINGS: Settings = {
    fees: {
        useAutomaticJitoTip: true,
        jitoTipAggressiveness: 'medium',
        useAutomaticPriorityFee: true
    },
    trade: {
        buySlippage: 0.5,    // 0.5% default buy slippage
        sellSlippage: 1.0    // 1.0% default sell slippage
    },
    connection: {},  // Empty since managed by CredentialsManager
    notifications: {
        enableDiscordWebhook: false,
        notifyOnTrades: true,
        notifyOnErrors: true
    }
};