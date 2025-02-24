# Eclipse CLI

Eclipse CLI is a powerful command-line interface tool for trading Solana memecoins. It supports trading on both Raydium and Pump.fun, providing seamless token swapping capabilities with real-time market data integration.

███████╗ ██████╗██╗     ██╗██████╗ ███████╗███████╗
██╔════╝██╔════╝██║     ██║██╔══██╗██╔════╝██╔════╝
█████╗  ██║     ██║     ██║██████╔╝███████╗█████╗  
██╔══╝  ██║     ██║     ██║██╔═══╝ ╚════██║██╔══╝  
███████╗╚██████╗███████╗██║██║     ███████║███████╗
╚══════╝ ╚═════╝╚══════╝╚═╝╚═╝     ╚══════╝╚══════╝

## Features

- **Token Trading**: Buy and sell Solana tokens using contract addresses
- **Multi-DEX Support**: Compatible with both Raydium and Pump.fun
- **Real-time Position Tracking**: Monitor PnL, average entry price, and position sizes
- **Wallet Management**: Check balances and transfer SOL between wallets
- **Customizable Settings**: Configure various parameters for optimal trading
- **Transaction Priority**: Adjustable Jito tip and priority fee settings
- **Discord Integration**: Set up webhooks for trade notifications

## Prerequisites

- Solana RPC URL
- WebSocket (WS) URL
- Wallet private key
- Discord webhook (optional)

## Installation

1. Download the latest release
2. Configure your settings through the CLI interface
3. Ensure you have sufficient SOL in your wallet for trading and fees

## Usage

Launch the program to access the following menu options:

————————————————————————————————————————————————————————————

Buy
Sell
Positions
Balance
Transfer
Copy Trade
Settings
Exit
————————————————————————————————————————————————————————————

### Menu Options

- **Buy**: Purchase tokens using contract address
- **Sell**: Sell tokens from your portfolio
- **Positions**: View current positions with detailed metrics
  - PnL
  - Average entry price
  - Amount sold
  - Amount remaining
- **Balance**: Check current SOL balance
- **Transfer**: Send SOL to other wallets
- **Settings**: Configure program parameters
  - Discord webhook URL
  - Wallet private key
  - GRPC URL
  - RPC URL
  - WS URL
  - Jito tip amount
  - Priority fee amount

## Fees

- A 0.5% fee per transaction is automatically sent to the developer
- Additional network fees apply based on your priority settings

## Important Notes

- RPC and WebSocket URLs are required for program operation
- Keep your private key secure and never share it
- Monitor your SOL balance for transaction fees
- The Copy Trade feature is available in the premium version only
- Set appropriate priority fees during high network congestion

## Security

- Never share your private key
- Use a dedicated wallet for trading
- Regularly monitor your Discord webhooks
- Review transactions before confirming

## Troubleshooting

Common issues:
- Connection errors: Verify RPC and WS URLs
- Failed transactions: Check SOL balance and priority fees
- Position tracking issues: Refresh positions page (currently broken)

## Disclaimer

Trading cryptocurrencies involves risk. This tool is provided as-is, and users are responsible for their trading decisions.

## Support

For issues and feature requests, please open a GitHub issue.

## License

All rights reserved. The free version includes basic trading functionality, while advanced features like copy trading are available in the premium version (coming soon).

