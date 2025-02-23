import sharp from 'sharp';
import path from 'path';
import { Position } from './portfolioTracker';
import axios from 'axios';
import { webhookURL } from './portfolioTracker';

interface TextSegment {
  text: string;
  fontWeight: string;
  xOffset: number;
  color?: string;
}

interface TextLayer {
  segments: TextSegment[];
  x: number;
  y: number;
  fontSize: string;
  color: string;
  maxWidth?: number;
}

export class ImageGenerator {
  private static instance: ImageGenerator;
  private backgroundPath: string;

  private constructor() {
    this.backgroundPath = path.join(__dirname, 'eclipsewebhook.png');
  }

  public static getInstance(): ImageGenerator {
    if (!ImageGenerator.instance) {
      ImageGenerator.instance = new ImageGenerator();
    }
    return ImageGenerator.instance;
  }

  /**
   * Estimate text width for offset calculations
   */
  private calculateTextWidth(text: string, fontSize: string): number {
    const size = parseInt(fontSize.replace('px', ''));
    const charWidths: { [key: string]: number } = {
      '.': 0.4,
      '-': 0.5,
      '0': 0.6,
      '1': 0.5,
      '2': 0.6,
      '3': 0.6,
      '4': 0.6,
      '5': 0.6,
      '6': 0.6,
      '7': 0.6,
      '8': 0.6,
      '9': 0.6,
      '$': 0.7,
      'default': 0.7
    };

    return text.split('').reduce((width, char) => {
      const charWidth = charWidths[char] || charWidths['default'];
      return width + (charWidth * size);
    }, 0);
  }

  /**
   * Compute dynamic offset for subsequent text segments
   */
  private calculateDynamicOffset(baseOffset: number, text: string, fontSize: string): number {
    const textWidth = this.calculateTextWidth(text, fontSize);
    return baseOffset + textWidth;
  }

  /**
   * Helper for placing "SOL" after numeric amounts
   */
  private calculateSolOffset(baseOffset: number, numberText: string, fontSize: string): number {
    return this.calculateDynamicOffset(baseOffset, numberText, fontSize) + 12;
  }

  /**
   * Build the text layers
   */
  private createTextLayers(position: Position): TextLayer[] {
    const profitColor = position.pnlPercentage >= 0 ? '#daa7e8' : '#eb2a57';

    // Net profit in USD
    const netProfitUsd = position.netProfitUsd ?? 0;
    // Format
    const profitValue = netProfitUsd < 0
      ? `-$${Math.abs(netProfitUsd).toFixed(2)}`
      : `$${netProfitUsd.toFixed(2)}`;

    // Format SOL values
    const investedValue = this.formatSolValue(position.totalValueBought);
    const soldValue = this.formatSolValue(position.totalValueSold);
    const remainingValue = this.formatSolValue(position.remainingValue);

    return [
      // Symbol
      {
        segments: [{
          text: position.symbol.toUpperCase(),
          fontWeight: 'bold',
          xOffset: 0
        }],
        x: 75,
        y: 140,
        fontSize: '80px',
        color: '#FFFFFF'
      },
      // Invested
      {
        segments: [
          { text: 'Invested: ', fontWeight: 'regular', xOffset: 0 },
          { text: investedValue, fontWeight: 'bold', xOffset: 147 },
          {
            text: ' SOL',
            fontWeight: 'regular',
            xOffset: this.calculateSolOffset(147, investedValue, '36px')
          }
        ],
        x: 75,
        y: 240,
        fontSize: '36px',
        color: '#FFFFFF'
      },
      // Sold
      {
        segments: [
          { text: 'Sold: ', fontWeight: 'regular', xOffset: 0 },
          { text: soldValue, fontWeight: 'bold', xOffset: 85 },
          {
            text: ' SOL',
            fontWeight: 'regular',
            xOffset: this.calculateSolOffset(85, soldValue, '36px')
          }
        ],
        x: 75,
        y: 300,
        fontSize: '36px',
        color: '#FFFFFF'
      },
      // Remaining
      {
        segments: [
          { text: 'Remaining: ', fontWeight: 'regular', xOffset: 0 },
          { text: remainingValue, fontWeight: 'bold', xOffset: 180 },
          {
            text: ' SOL',
            fontWeight: 'regular',
            xOffset: this.calculateSolOffset(180, remainingValue, '36px')
          }
        ],
        x: 75,
        y: 360,
        fontSize: '36px',
        color: '#FFFFFF'
      },
      // ROI
      {
        segments: [
          { text: 'ROI: ', fontWeight: 'regular', xOffset: 0 },
          {
            text: position.pnlPercentage.toFixed(2),
            fontWeight: 'bold',
            xOffset: position.pnlPercentage < 0 ? 73 : 75,
            color: profitColor
          },
          {
            text: '%',
            fontWeight: 'regular',
            xOffset: this.calculateDynamicOffset(
              position.pnlPercentage < 0 ? 73 : 75,
              position.pnlPercentage.toFixed(2),
              '36px'
            ) + 8,
            color: profitColor
          }
        ],
        x: 75,
        y: 420,
        fontSize: '36px',
        color: '#FFFFFF'
      },
      // Profit (label)
      {
        segments: [{
          text: 'Profit',
          fontWeight: 'regular',
          xOffset: 0
        }],
        x: 510,
        y: 240,
        fontSize: '36px',
        color: '#FFFFFF'
      },
      // Profit (value) in USD
      {
        segments: [{
          text: profitValue,
          fontWeight: 'bold',
          xOffset: netProfitUsd < 0 ? -35 : 0,
          color: profitColor
        }],
        x: 510,
        y: 320,
        fontSize: '72px',
        color: '#FFFFFF'
      }
    ];
  }

  /**
   * Generate final image
   */
  public async generatePositionImage(position: Position): Promise<Buffer> {
    const textLayers = this.createTextLayers(position);
    const svgText = this.createSVGText(textLayers);
    const svgBuffer = Buffer.from(svgText);

    return await sharp(this.backgroundPath)
      .resize(1200, 600, {
        fit: 'contain',
        background: { r: 0, g: 0, b: 0, alpha: 0 }
      })
      .composite([{
        input: svgBuffer,
        top: 0,
        left: 0
      }])
      .toBuffer();
  }

  /**
   * Convert the text layers to inline SVG
   */
  private createSVGText(layers: TextLayer[]): string {
    const svgElements = layers.map(layer => {
      const segmentElements = layer.segments.map(segment => {
        const textProps = [
          `x="${layer.x + segment.xOffset}"`,
          `y="${layer.y}"`,
          `font-family="SF Pro Display"`,
          `font-size="${layer.fontSize}"`,
          `font-weight="${segment.fontWeight}"`,
          `fill="${segment.color || layer.color}"`,
        ].join(' ');

        return `<text ${textProps}>${segment.text}</text>`;
      }).join('\n');

      return segmentElements;
    }).join('\n');

    return `
      <svg width="1200" height="600" viewBox="0 0 1200 600" xmlns="http://www.w3.org/2000/svg">
        <style>
          @font-face {
            font-family: 'SF Pro Display';
            src: local('SF Pro Display');
          }
        </style>
        ${svgElements}
      </svg>
    `;
  }

  /**
   * Format SOL values for display
   */
  private formatSolValue(value: number): string {
    return value >= 1 ? value.toFixed(2) : value.toFixed(6);
  }

  /**
   * Send generated image to Discord
   */
  public async sendToDiscord(imageBuffer: Buffer, position: Position): Promise<void> {
    try {
      const form = new FormData();
      const blob = new Blob([imageBuffer], { type: 'image/png' });
      form.append('file', blob, 'position.png');
      
      const message = {
        content: `Position Update for ${position.symbol}`,
        username: 'Portfolio Tracker'
      };
      
      form.append('payload_json', JSON.stringify(message));

      await axios.post(webhookURL, form, {
        headers: {
          'Content-Type': 'multipart/form-data'
        }
      });
    } catch (error) {
      console.error('Error sending image to Discord:', error);
      throw error;
    }
  }
}
