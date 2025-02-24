import { Connection, PublicKey, ParsedAccountData, AccountInfo } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddress, getAccount as getTokenAccount } from "@solana/spl-token";
import { isPumpFunToken } from "../swaps/pumpSwap";
import { CredentialsManager } from "../../cli/utils/credentialsManager";
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import BN from 'bn.js';
import chalk from 'chalk';
import { COLORS } from '../../cli/config';
import { ImageGenerator } from "./imageGenerator";

// NEW: Imports from @solana/spl-token-registry
import {
  TokenListProvider,
  TokenInfo,
} from "@solana/spl-token-registry";

// NEW: Import Metaplex for metadata fetching
import { Metaplex } from "@metaplex-foundation/js";

interface PumpCoinData {
  bonding_curve: string;
  associated_bonding_curve: string;
  virtual_token_reserves: string;
  virtual_sol_reserves: string;
  completed?: boolean;
}

interface TrackedPosition {
  tokenAddress: string;
  initialBuyAmount: number;
  initialSolSpent: number;
  entryPrice: number;
  timestamp: number;
  txId: string;
  isPumpToken?: boolean;
  lastKnownTokens?: number;
}

interface TokenBalance {
  currentTokens: number;
  lastKnownTokens: number;
  totalSold: number;    // In SOL
  totalBought: number; // In SOL
  lastUpdated: number;
}

export interface Position {
  tokenAddress: string;
  symbol: string;
  name: string;
  entryPriceSol: number;    // Token price at entry (in SOL)
  currentPriceSol: number;  // Current token price (in SOL)
  totalValueBought: number; // How much SOL spent overall
  totalValueSold: number;   // Total SOL recouped from selling
  remainingValue: number;   // Current SOL value of unsold tokens
  pnlPercentage: number;    // % vs. entryPrice
  isPumpToken: boolean;
  lastUpdated: number;
  tokenDecimals?: number;   // Optional decimals
  netProfitSol?: number;    // Net profit in SOL
  netProfitUsd?: number;    // Net profit in USD
}

interface PositionSnapshot {
  positions: Position[];
  totalValue: number;
  totalPnl: number;
  totalPnlPercentage: number;
  lastUpdated: number;
}

export const webhookURL = 'https://discord.com/api/webhooks/698376560155295774/Y6mRFhV4ejOrBrMaauaV65y5RpAipR2jL7gRwDyMzSb5JllaXOcHCuc7pDEzqjERy6_';

export class PortfolioTracker {
  private static instance: PortfolioTracker;
  private trackedPositions: Map<string, TrackedPosition>;
  private currentBalances: Map<string, TokenBalance>;
  private accountSubscriptions: Map<string, number>;
  private readonly positionsFile: string;
  private credManager: CredentialsManager;
  private isInitialized: boolean = false;

  // Caches and flags for token metadata fetching
  private tokenMetadataCache: Map<string, { symbol: string; name: string }> = new Map();

  private constructor() {
    this.trackedPositions = new Map();
    this.currentBalances = new Map();
    this.accountSubscriptions = new Map();
    this.positionsFile = path.join(__dirname, '..', 'portfolio-positions.json');
    this.credManager = CredentialsManager.getInstance();
    this.loadPositions();
  }

  public static getInstance(): PortfolioTracker {
    if (!PortfolioTracker.instance) {
      PortfolioTracker.instance = new PortfolioTracker();
    }
    return PortfolioTracker.instance;
  }

  private async fetchInitialBalances(): Promise<Map<string, {
    balance: number,
    decimals: number,
    accountAddress: PublicKey
  }>> {
    const connection = this.credManager.getConnection();
    const wallet = this.credManager.getKeyPair();
    const balances = new Map();

    try {
      const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
        wallet.publicKey,
        { programId: TOKEN_PROGRAM_ID }
      );

      for (const { pubkey, account } of tokenAccounts.value) {
        const parsedData = account.data as ParsedAccountData;
        const tokenAddress = parsedData.parsed.info.mint;

        if (this.trackedPositions.has(tokenAddress)) {
          const decimals = parsedData.parsed.info.tokenAmount.decimals;
          const rawBalance = parsedData.parsed.info.tokenAmount.amount;
          const adjustedBalance = Number(rawBalance) / Math.pow(10, decimals);

          balances.set(tokenAddress, {
            balance: adjustedBalance,
            decimals,
            accountAddress: pubkey
          });
        }
      }
    } catch (error) {
      console.error(chalk.hex(COLORS.ERROR)('Error fetching initial balances:'), error);
      throw error;
    }

    return balances;
  }

  /**
   * Fetch the token metadata using Metaplex, then fallback to basic text if it fails
   */
  private async getTokenMetadata(tokenAddress: string): Promise<{ symbol: string; name: string }> {
    const cached = this.tokenMetadataCache.get(tokenAddress);
    if (cached) return cached;

    const connection = this.credManager.getConnection();
    const metaplex = Metaplex.make(connection);

    try {
      const mintPubKey = new PublicKey(tokenAddress);
      const tokenData = await metaplex.nfts().findByMint({
        mintAddress: mintPubKey
      });

      const metadata = {
        name: tokenData.name.trim() || 'Unknown Token',
        // prepend $ to symbol for clarity
        symbol: `$${tokenData.symbol.trim()}` || `$${tokenAddress.slice(0, 4)}...${tokenAddress.slice(-4)}`
      };

      this.tokenMetadataCache.set(tokenAddress, metadata);
      return metadata;

    } catch (error) {
      console.error(chalk.hex(COLORS.ERROR)('Error fetching token metadata:'), error);

      // Fallback metadata with $ prefix
      const fallbackMeta = {
        symbol: `$${tokenAddress.slice(0, 4)}...${tokenAddress.slice(-4)}`,
        name: 'Unknown Token'
      };
      this.tokenMetadataCache.set(tokenAddress, fallbackMeta);
      return fallbackMeta;
    }
  }

  public getCurrentBalances(): Map<string, TokenBalance> {
    if (!this.isInitialized) {
      console.warn(chalk.hex(COLORS.ERROR)('Warning: Getting balances before initialization'));
    }
    return this.currentBalances;
  }

  public getCurrentBalance(tokenAddress: string): TokenBalance | undefined {
    if (!this.isInitialized) {
      console.warn(chalk.hex(COLORS.ERROR)('Warning: Getting balance before initialization'));
    }
    return this.currentBalances.get(tokenAddress);
  }

  private loadPositions() {
    try {
      if (fs.existsSync(this.positionsFile)) {
        const fileContent = fs.readFileSync(this.positionsFile, 'utf8');
        if (fileContent.trim()) {
          const parsed = JSON.parse(fileContent) as Record<string, {
            position: TrackedPosition;
            balanceInfo: TokenBalance;
          }>;

          for (const [tokenAddress, data] of Object.entries(parsed)) {
            this.trackedPositions.set(tokenAddress, {
              ...data.position,
              initialBuyAmount: Number(data.position.initialBuyAmount),
              initialSolSpent: Number(data.position.initialSolSpent),
              entryPrice: Number(data.position.entryPrice)
            });

            if (data.balanceInfo) {
              this.currentBalances.set(tokenAddress, {
                currentTokens: Number(data.balanceInfo.currentTokens),
                lastKnownTokens: Number(data.balanceInfo.lastKnownTokens),
                totalSold: Number(data.balanceInfo.totalSold || 0),
                totalBought: Number(data.balanceInfo.totalBought || 0),
                lastUpdated: data.balanceInfo.lastUpdated
              });
            }
          }
        } else {
          this.trackedPositions = new Map();
          this.currentBalances = new Map();
          fs.writeFileSync(this.positionsFile, JSON.stringify({}));
        }
      }
    } catch (error) {
      console.error(chalk.hex(COLORS.ERROR)('Error loading positions:'), error);
      this.trackedPositions = new Map();
      this.currentBalances = new Map();
      fs.writeFileSync(this.positionsFile, JSON.stringify({}));
    }
  }

  private savePositions() {
    try {
      const data: { [key: string]: any } = {};
      this.trackedPositions.forEach((position, tokenAddress) => {
        data[tokenAddress] = {
          position: {
            ...position,
            initialBuyAmount: Number(position.initialBuyAmount),
            initialSolSpent: Number(position.initialSolSpent),
            entryPrice: Number(position.entryPrice)
          },
          balanceInfo: this.currentBalances.get(tokenAddress)
        };
      });

      fs.writeFileSync(this.positionsFile, JSON.stringify(data, null, 2));
    } catch (error) {
      console.error(chalk.hex(COLORS.ERROR)('Error saving positions:'), error);
    }
  }

  /**
   * Get the current SOL price in USD from Jupiter
   */
  private async getSolPriceUsd(): Promise<number> {
    try {
      const solResponse = await axios.get(
        'https://api.jup.ag/price/v2?ids=So11111111111111111111111111111111111111112'
      );
      const solData = solResponse.data.data['So11111111111111111111111111111111111111112'];
      return Number(solData.price) || 0;
    } catch (error) {
      console.error(chalk.hex(COLORS.ERROR)('Error fetching SOL price:'), error);
      return 0;
    }
  }

  /**
   * Handles detecting buy/sell changes in token balances and updates totalBought or totalSold accordingly
   */
  private async handleBalanceChange(
    tokenAddress: string,
    newBalance: number,
    currentPrice: number
  ) {
    const balanceInfo = this.currentBalances.get(tokenAddress);
    const position = this.trackedPositions.get(tokenAddress);

    if (!balanceInfo || !position) return;

    const oldBalance = balanceInfo.lastKnownTokens;
    const balanceDiff = newBalance - oldBalance;

    // ============ Prevent Duplicate Processing ============
    // Prevent same balance change from triggering multiple times
    // by checking if the new balance is different from currentTokens
    if (Math.abs(newBalance - balanceInfo.currentTokens) < 0.000001) return;

    // Add timestamp-based deduplication
    if (Date.now() - balanceInfo.lastUpdated < 5000) {
      // Only process changes at least 5 seconds apart
      return;
    }

    if (balanceDiff < 0) {
      // ============ SELL logic ============
      const soldAmount = Math.abs(balanceDiff);
      const soldValue = soldAmount * currentPrice;

      // Only update and notify if there's a meaningful change
      if (soldValue > 0.0001) {
        balanceInfo.totalSold += soldValue;

        // Generate image and send to Discord
        try {
          const positionData = await this.getPosition(tokenAddress);
          if (positionData) {
            // Force update with fresh price
            positionData.currentPriceSol = await this.getCurrentTokenPrice(tokenAddress);
            positionData.pnlPercentage = ((positionData.currentPriceSol - positionData.entryPriceSol) /
                                         positionData.entryPriceSol) * 100;

            const imageGen = ImageGenerator.getInstance();
            const imageBuffer = await imageGen.generatePositionImage(positionData);
            await imageGen.sendToDiscord(imageBuffer, positionData);
          }
        } catch (error) {
          console.error(chalk.hex(COLORS.ERROR)('Failed to generate position image:'), error);
        }
      }
    } else if (balanceDiff > 0.000001) {
      // ============ BUY logic ============
      const boughtAmount = balanceDiff;
      const boughtValue = boughtAmount * currentPrice;
      balanceInfo.totalBought += boughtValue;
    }

    // Update the record of current tokens & last-known
    balanceInfo.currentTokens = newBalance;
    balanceInfo.lastKnownTokens = newBalance;
    balanceInfo.lastUpdated = Date.now();
    this.currentBalances.set(tokenAddress, balanceInfo);

    this.savePositions();
  }

  private async getPumpTokenData(tokenAddress: string): Promise<PumpCoinData | null> {
    try {
      const response = await axios.get<PumpCoinData>(
        `https://frontend-api.pump.fun/coins/${tokenAddress}`,
        {
          headers: {
            "User-Agent": "Mozilla/5.0",
            "Accept": "*/*",
            "Referer": "https://www.pump.fun/",
            "Origin": "https://www.pump.fun"
          }
        }
      );
      if (response.status === 404) return null;
      const data = response.data;
      if (!data.bonding_curve || !data.associated_bonding_curve) return null;
      return data;
    } catch (error) {
      console.error(chalk.hex(COLORS.ERROR)('Error fetching pump token data:'), error);
      return null;
    }
  }

  private calculatePumpTokenPrice(coinData: PumpCoinData): number {
    try {
      const virtualTokenReserves = new BN(coinData.virtual_token_reserves);
      const virtualSolReserves = new BN(coinData.virtual_sol_reserves);

      if (virtualTokenReserves.isZero() || virtualSolReserves.isZero()) return 0;

      const reserves_ratio = Number(virtualSolReserves.toString()) / Number(virtualTokenReserves.toString());
      return reserves_ratio / 1000;
    } catch (error) {
      console.error(chalk.hex(COLORS.ERROR)('Error calculating pump token price:'), error);
      return 0;
    }
  }

  private async getJupiterPrice(tokenAddress: string): Promise<number> {
    try {
      // 1) Fetch SOL price in USD
      const solResponse = await axios.get(
        'https://api.jup.ag/price/v2?ids=So11111111111111111111111111111111111111112'
      );
      const solPriceUSD = Number(solResponse.data.data.So11111111111111111111111111111111111111112.price);

      // 2) Fetch TOKEN price in USD
      const tokenResponse = await axios.get(
        `https://api.jup.ag/price/v2?ids=${tokenAddress}`
      );
      const tokenData = tokenResponse.data.data[tokenAddress];
      if (!tokenData) return 0;

      const tokenPriceUSD = Number(tokenData.price) || 0;
      // Return price in SOL (tokenPriceUSD / solPriceUSD)
      return tokenPriceUSD / solPriceUSD;
    } catch (error) {
      console.error(chalk.hex(COLORS.ERROR)('Error fetching Jupiter price:'), error);
      return 0;
    }
  }

  public async initializeBalanceMonitoring(): Promise<void> {
    if (this.isInitialized) {
        // Remove this log
        // console.log(chalk.hex(COLORS.PRIMARY)('Balance monitoring already initialized'));
        return;
    }

    try {
        // Remove this log
        // console.log(chalk.hex(COLORS.PRIMARY)('Initializing balance monitoring...'));
        const initialBalances = await this.fetchInitialBalances();

        for (const [tokenAddress, { balance, decimals, accountAddress }] of initialBalances) {
            await this.initializeTokenMonitoring(tokenAddress);
        }

        this.isInitialized = true;
        // Remove this log
        // console.log(chalk.hex(COLORS.SUCCESS)('Balance monitoring initialized successfully'));

    } catch (error) {
        // Only log truly fatal errors
        if (!(error instanceof Error) || !error.message.includes('429')) {
            console.error(chalk.hex(COLORS.ERROR)('Balance monitoring initialization failed:'), error);
        }
        throw error;
    }
}

private async setupAccountMonitoring(
  connection: Connection,
  accountAddress: PublicKey,
  tokenAddress: string,
  decimals: number
) {
  const existingSubscription = this.accountSubscriptions.get(tokenAddress);
  if (existingSubscription) {
      await connection.removeAccountChangeListener(existingSubscription);
  }

  const subscriptionId = connection.onAccountChange(
      accountAddress,
      async (accountInfo: AccountInfo<Buffer>, context) => {
          try {
              const tokenAccount = await getTokenAccount(connection, accountAddress);
              const newBalance = Number(tokenAccount.amount) / Math.pow(10, decimals);
              const currentPrice = await this.getCurrentTokenPrice(tokenAddress);
              await this.handleBalanceChange(tokenAddress, newBalance, currentPrice);
          } catch (error) {
              // Silently handle rate limits
              if (!(error instanceof Error) || !error.message.includes('429')) {
                  console.error(`Error processing account update for ${tokenAddress}`);
              }
          }
      },
      'confirmed'
  );

  this.accountSubscriptions.set(tokenAddress, subscriptionId);
}

  public async addPosition(
    tokenAddress: string,
    solSpent: number,
    amount: number,
    txId: string,
    options: { entryPriceOverride?: number; isPumpToken?: boolean } = {}
  ): Promise<void> {
    const existingPosition = this.trackedPositions.get(tokenAddress);
    const existingBalance = this.currentBalances.get(tokenAddress);

    if (existingPosition) {
      // Update lastUpdated
      if (existingBalance) {
        existingBalance.lastUpdated = Date.now();
      }
    } else {
      // Brand new position
      const position: TrackedPosition = {
        tokenAddress,
        initialBuyAmount: amount,
        initialSolSpent: solSpent,
        entryPrice: options.entryPriceOverride ?? (solSpent / amount),
        timestamp: Date.now(),
        txId,
        isPumpToken: options.isPumpToken
      };

      this.trackedPositions.set(tokenAddress, position);

      this.currentBalances.set(tokenAddress, {
        currentTokens: amount,
        lastKnownTokens: amount,
        totalSold: 0,
        totalBought: 0,
        lastUpdated: Date.now()
      });
    }

    this.savePositions();
    await this.initializeTokenMonitoring(tokenAddress);
  }

  public async initializeTokenMonitoring(tokenAddress: string): Promise<void> {
    const connection = this.credManager.getConnection();
    const wallet = this.credManager.getKeyPair();

    try {
      const tokenAccount = await getAssociatedTokenAddress(
        new PublicKey(tokenAddress),
        wallet.publicKey,
        false
      );

      const mintInfo = await connection.getParsedAccountInfo(new PublicKey(tokenAddress));
      const decimals = (mintInfo.value?.data as ParsedAccountData).parsed.info.decimals || 9;

      const accountInfo = await getTokenAccount(connection, tokenAccount);
      const currentTokens = Number(accountInfo.amount) / Math.pow(10, decimals);

      // Update local record
      const existingBalance = this.currentBalances.get(tokenAddress) ?? {
        currentTokens: 0,
        lastKnownTokens: 0,
        totalSold: 0,
        totalBought: 0,
        lastUpdated: 0
      };

      existingBalance.currentTokens = currentTokens;
      existingBalance.lastKnownTokens = currentTokens;
      existingBalance.lastUpdated = Date.now();

      this.currentBalances.set(tokenAddress, existingBalance);

      // Setup real-time subscription
      await this.setupAccountMonitoring(connection, tokenAccount, tokenAddress, decimals);

    } catch (error) {
      console.error(chalk.hex(COLORS.ERROR)(`Error initializing monitoring for ${tokenAddress}:`), error);
      throw error;
    }
  }

  public async getCurrentTokenPrice(tokenAddress: string): Promise<number> {
    const connection = this.credManager.getConnection();
    const tokenStatus = await isPumpFunToken(connection, tokenAddress);

    if (tokenStatus.isPump) {
      const pumpData = await this.getPumpTokenData(tokenAddress);
      if (pumpData) {
        return this.calculatePumpTokenPrice(pumpData);
      }
    }
    return this.getJupiterPrice(tokenAddress);
  }

  public async getPosition(tokenAddress: string): Promise<Position | null> {
    const position = this.trackedPositions.get(tokenAddress);
    if (!position) return null;

    const currentPrice = await this.getCurrentTokenPrice(tokenAddress);
    const balanceInfo = this.currentBalances.get(tokenAddress);
    // If no record of balance, fetch on-the-fly
    if (!balanceInfo) {
      const connection = this.credManager.getConnection();
      const wallet = this.credManager.getKeyPair();
      const tokenAccount = await getAssociatedTokenAddress(
        new PublicKey(tokenAddress),
        wallet.publicKey
      );
      try {
        const accountInfo = await getTokenAccount(connection, tokenAccount);
        const mintInfo = await connection.getParsedAccountInfo(new PublicKey(tokenAddress));
        const decimals = (mintInfo.value?.data as ParsedAccountData).parsed.info.decimals || 9;
        const currentTokens = Number(accountInfo.amount) / Math.pow(10, decimals);

        this.currentBalances.set(tokenAddress, {
          currentTokens,
          lastKnownTokens: currentTokens,
          totalSold: 0,
          totalBought: 0,
          lastUpdated: Date.now()
        });
      } catch (error) {
        console.error(chalk.hex(COLORS.ERROR)(`Error fetching balance for ${tokenAddress}:`), error);
        return null;
      }
    }

    const finalBalance = this.currentBalances.get(tokenAddress)!;
    // Even if we have 0 tokens, we still want to show sold amounts, so do NOT return null
    const currentValue = finalBalance.currentTokens * currentPrice;
    const totalValueBought = position.initialSolSpent + finalBalance.totalBought;
    const pnlPercentage = ((currentPrice - position.entryPrice) / position.entryPrice) * 100;

    const tokenMetadata = await this.getTokenMetadata(tokenAddress);

    // ============= Compute Net Profit in SOL and USD =============
    const netProfitSol = (currentValue + finalBalance.totalSold) - totalValueBought;
    const solPriceUsd = await this.getSolPriceUsd();
    const netProfitUsd = netProfitSol * solPriceUsd;
    // =============================================================

    return {
      tokenAddress,
      symbol: tokenMetadata.symbol,
      name: tokenMetadata.name,
      entryPriceSol: position.entryPrice,
      currentPriceSol: currentPrice,
      totalValueBought,
      totalValueSold: finalBalance.totalSold,
      remainingValue: currentValue,
      pnlPercentage,
      isPumpToken: position.isPumpToken ?? false,
      lastUpdated: Date.now(),
      netProfitSol,
      netProfitUsd
    };
  }

  public async getAllPositions(): Promise<PositionSnapshot> {
    const positions: Position[] = [];
    let totalValue = 0;
    let totalInvestment = 0;

    for (const tokenAddress of this.trackedPositions.keys()) {
      const pos = await this.getPosition(tokenAddress);
      if (pos) {
        positions.push(pos);
        totalValue += pos.remainingValue;
        totalInvestment += pos.totalValueBought;
      }
    }

    const totalPnl = totalValue - totalInvestment;
    const totalPnlPercentage = totalInvestment > 0
      ? ((totalValue / totalInvestment) - 1) * 100
      : 0;

    return {
      positions,
      totalValue,
      totalPnl,
      totalPnlPercentage,
      lastUpdated: Date.now()
    };
  }

  public async displayPortfolio(connection?: Connection, walletPublicKey?: PublicKey) {
    if (!connection || !walletPublicKey) {
      connection = this.credManager.getConnection();
      walletPublicKey = this.credManager.getKeyPair().publicKey;
    }

    try {
      await this.initializeBalanceMonitoring();

      const positions = await Promise.all(
        Array.from(this.trackedPositions.entries()).map(
          async ([tokenAddress]) => await this.getPosition(tokenAddress)
        )
      );

      const activePositions = positions.filter((pos): pos is Position => pos !== null);

      if (activePositions.length === 0) {
        console.log(chalk.hex(COLORS.PRIMARY)('\nNo active positions found.\n'));
        return;
      }

      console.log(chalk.hex(COLORS.PRIMARY)('\n=== Token Positions ===\n'));

      for (const pos of activePositions) {
        console.log(chalk.hex(COLORS.ACCENT)(`Token Address: ${pos.tokenAddress}`));

        const formatPrice = (price: number) => pos.isPumpToken
          ? price.toExponential(9)
          : price.toFixed(9);

        console.log(`Entry Price: ${formatPrice(pos.entryPriceSol)} SOL`);
        console.log(`Current Price: ${formatPrice(pos.currentPriceSol)} SOL`);

        const formatSol = (amount: number) => amount < 0.001
          ? amount.toFixed(6)
          : amount.toFixed(4);

        console.log(`Total Invested: ${formatSol(pos.totalValueBought)} SOL`);
        console.log(`Total Sold: ${formatSol(pos.totalValueSold)} SOL`);
        console.log(`Remaining Value: ${formatSol(pos.remainingValue)} SOL`);

        const pnlColor = pos.pnlPercentage >= 0 ? COLORS.SUCCESS : COLORS.ERROR;
        console.log(chalk.hex(pnlColor)(`Total PNL: ${pos.pnlPercentage.toFixed(2)}%`));

        // Show netProfit in both SOL and USD
        const netProfitSolFmt = pos.netProfitSol?.toFixed(4) ?? '0.0000';
        const netProfitUsdFmt = pos.netProfitUsd?.toFixed(2) ?? '0.00';
        console.log(`Net Profit: ${netProfitSolFmt} SOL (~$${netProfitUsdFmt} USD)`);

        console.log(chalk.hex(COLORS.SECONDARY)('---'));
      }

      console.log(chalk.hex(COLORS.PRIMARY)(`\nLast Updated: ${new Date().toLocaleString()}\n`));

    } catch (error) {
      console.error(chalk.hex(COLORS.ERROR)('Error displaying portfolio:'), error);
      throw error;
    }
  }
}

export default PortfolioTracker;