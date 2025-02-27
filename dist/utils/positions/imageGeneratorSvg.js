"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ImageGenerator = void 0;
const axios_1 = __importDefault(require("axios"));
const portfolioTracker_1 = require("./portfolioTracker");
const logger_1 = require("../../cli/utils/logger");
const config_1 = require("../../cli/config");
const chalk_1 = __importDefault(require("chalk"));
const logger = logger_1.Logger.getInstance();
/**
 * SVG-based ImageGenerator that doesn't require native dependencies like Sharp
 * Generates portfolio position visualizations for Discord without external libraries
 */
class ImageGenerator {
    constructor() {
        logger.debug('ImageGenerator', 'SVG-based image generator initialized');
    }
    static getInstance() {
        if (!ImageGenerator.instance) {
            ImageGenerator.instance = new ImageGenerator();
        }
        return ImageGenerator.instance;
    }
    /**
     * Generate a stand-alone SVG image for a position
     */
    generatePositionSvg(position) {
        const profitColor = position.pnlPercentage >= 0 ? '#daa7e8' : '#eb2a57';
        // Format values
        const netProfitUsd = position.netProfitUsd ?? 0;
        const profitValue = netProfitUsd < 0
            ? `-$${Math.abs(netProfitUsd).toFixed(2)}`
            : `$${netProfitUsd.toFixed(2)}`;
        const investedValue = this.formatSolValue(position.totalValueBought);
        const soldValue = this.formatSolValue(position.totalValueSold);
        const remainingValue = this.formatSolValue(position.remainingValue);
        // Create SVG
        return `
      <svg width="1200" height="600" viewBox="0 0 1200 600" xmlns="http://www.w3.org/2000/svg">
        <!-- Background -->
        <rect width="1200" height="600" fill="#1a1a1a" />
        
        <!-- Gradient overlay -->
        <defs>
          <linearGradient id="headerGradient" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" style="stop-color:#FF9277;stop-opacity:0.5" />
            <stop offset="100%" style="stop-color:#D3D3FF;stop-opacity:0.2" />
          </linearGradient>
          <linearGradient id="footerGradient" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" style="stop-color:#D3D3FF;stop-opacity:0.2" />
            <stop offset="100%" style="stop-color:#FF9277;stop-opacity:0.5" />
          </linearGradient>
        </defs>
        
        <!-- Header gradient -->
        <rect width="1200" height="120" fill="url(#headerGradient)" />
        
        <!-- Footer gradient -->
        <rect y="480" width="1200" height="120" fill="url(#footerGradient)" />
        
        <!-- Eclipse Logo -->
        <text x="50" y="70" font-family="Arial, sans-serif" font-size="40" font-weight="bold" fill="white">ECLIPSE TRADER</text>
        
        <!-- Main content -->
        <g transform="translate(0, 50)">
          <!-- Symbol -->
          <text x="75" y="140" font-family="Arial, sans-serif" font-size="80" font-weight="bold" fill="white">${position.symbol.toUpperCase()}</text>
          
          <!-- Left column info -->
          <text x="75" y="240" font-family="Arial, sans-serif" font-size="36" fill="white">Invested: <tspan font-weight="bold">${investedValue}</tspan> SOL</text>
          <text x="75" y="300" font-family="Arial, sans-serif" font-size="36" fill="white">Sold: <tspan font-weight="bold">${soldValue}</tspan> SOL</text>
          <text x="75" y="360" font-family="Arial, sans-serif" font-size="36" fill="white">Remaining: <tspan font-weight="bold">${remainingValue}</tspan> SOL</text>
          <text x="75" y="420" font-family="Arial, sans-serif" font-size="36" fill="white">ROI: <tspan font-weight="bold" fill="${profitColor}">${position.pnlPercentage.toFixed(2)}%</tspan></text>
          
          <!-- Right column -->
          <text x="510" y="240" font-family="Arial, sans-serif" font-size="36" fill="white">Profit</text>
          <text x="${netProfitUsd < 0 ? '475' : '510'}" y="320" font-family="Arial, sans-serif" font-size="72" font-weight="bold" fill="${profitColor}">${profitValue}</text>
          
          <!-- Current SOL Price -->
          <text x="510" y="400" font-family="Arial, sans-serif" font-size="28" fill="#888888">Current Price: ${position.currentPriceSol.toExponential(6)} SOL</text>
          
          <!-- Entry Price -->
          <text x="510" y="440" font-family="Arial, sans-serif" font-size="28" fill="#888888">Entry Price: ${position.entryPriceSol.toExponential(6)} SOL</text>
          
          <!-- Eclipse watermark -->
          <text x="950" y="480" font-family="Arial, sans-serif" font-size="24" fill="#555555">Eclipse Trader · ${new Date().toISOString().split('T')[0]}</text>
        </g>
      </svg>
    `;
    }
    /**
     * Generate an image buffer from the position
     * This method mirrors the original imageGenerator's method
     */
    async generatePositionImage(position) {
        // Create SVG and convert to buffer
        const svg = this.generatePositionSvg(position);
        return Buffer.from(svg, 'utf-8');
    }
    /**
     * Send image to Discord - matches the signature of the original method
     * to maintain compatibility
     */
    async sendToDiscord(imageBufferOrPosition, position) {
        try {
            // Handle both possible signatures
            let actualPosition;
            let svgContent;
            if (Buffer.isBuffer(imageBufferOrPosition)) {
                // If called with (Buffer, Position) signature
                if (!position) {
                    throw new Error('Position parameter is required when first parameter is a Buffer');
                }
                actualPosition = position;
                // Generate new SVG (ignore the buffer)
                svgContent = this.generatePositionSvg(actualPosition);
            }
            else {
                // If called with (Position) signature
                actualPosition = imageBufferOrPosition;
                svgContent = this.generatePositionSvg(actualPosition);
            }
            // Create a form with SVG data
            const form = new FormData();
            form.append('payload_json', JSON.stringify({
                content: `Position Update for ${actualPosition.symbol}`,
                username: 'Eclipse Portfolio Tracker'
            }));
            // Convert SVG to Blob and append to form
            const svgBlob = new Blob([svgContent], { type: 'image/svg+xml' });
            form.append('file', svgBlob, 'position.svg');
            // Send to Discord webhook
            await axios_1.default.post(portfolioTracker_1.webhookURL, form, {
                headers: {
                    'Content-Type': 'multipart/form-data'
                }
            });
            logger.success('ImageGenerator', `Position for ${actualPosition.symbol} sent to Discord`);
        }
        catch (error) {
            logger.error('ImageGenerator', 'Error sending to Discord', error);
            console.error(chalk_1.default.hex(config_1.COLORS.ERROR)('Error sending image to Discord:'), error);
            throw error;
        }
    }
    /**
     * Format SOL values for display
     */
    formatSolValue(value) {
        return value >= 1 ? value.toFixed(2) : value.toFixed(6);
    }
    /**
     * Helper method to convert colors to RGB values
     */
    hexToRgb(hex) {
        // Remove # if present
        hex = hex.replace(/^#/, '');
        // Parse hex
        const bigint = parseInt(hex, 16);
        const r = (bigint >> 16) & 255;
        const g = (bigint >> 8) & 255;
        const b = bigint & 255;
        return { r, g, b };
    }
}
exports.ImageGenerator = ImageGenerator;
