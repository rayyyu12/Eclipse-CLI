"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.COLORS = exports.ASCII_BANNER = exports.CONFIG = void 0;
// src/cli/config.ts
exports.CONFIG = {
    MENU_WIDTH: 60,
    MIN_SOL_AMOUNT: 0,
    MAX_SOL_AMOUNT: 100000,
    DEFAULT_SLIPPAGE: 0.01,
    SPINNER_COLOR: 'cyan',
    COMMANDS: {
        BUY: '1',
        SELL: '2',
        POSITIONS: '3',
        BALANCE: '4',
        TRANSFER: '5',
        COPY_TRADE: '6',
        SETTINGS: '7',
        EXIT: '8'
    }
};
exports.ASCII_BANNER = `
███████╗ ██████╗██╗     ██╗██████╗ ███████╗███████╗
██╔════╝██╔════╝██║     ██║██╔══██╗██╔════╝██╔════╝
█████╗  ██║     ██║     ██║██████╔╝███████╗█████╗  
██╔══╝  ██║     ██║     ██║██╔═══╝ ╚════██║██╔══╝  
███████╗╚██████╗███████╗██║██║     ███████║███████╗
╚══════╝ ╚═════╝╚══════╝╚═╝╚═╝     ╚══════╝╚══════╝
`;
exports.COLORS = {
    PRIMARY: '#FF9277', // Coral/peach orange
    SECONDARY: '#2A2A2A', // Dark gray/black
    ACCENT: '#F5E6DE', // Beige/cream
    BACKGROUND: '#D3D3D3', // Light gray/silver
    ERROR: '#b52b40', // Red
    WARNING: '#b52b40',
    SUCCESS: '#D3D3FF', // Lavender
    LOGO: "#e29393"
};
