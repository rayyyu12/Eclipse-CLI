import { Connection, PublicKey, ParsedAccountData } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddress, getAccount as getTokenAccount } from "@solana/spl-token";
import { isPumpFunToken } from "../swaps/pumpSwap";
import { CredentialsManager } from "../../cli/utils/credentialsManager";
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import BN from 'bn.js';
import chalk from 'chalk';
import { COLORS } from '../../cli/config';
import { EventEmitter } from "events";
import { Metaplex } from "@metaplex-foundation/js";
import { Logger } from "../../cli/utils/logger";

// Interfaces
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
  totalBought: number;  // In SOL
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

interface BalanceUpdateEvent {
  tokenAddress: string;
  oldBalance: number;
  newBalance: number;
  change: number;
  timestamp: Date;
}

export const webhookURL = 'https://discord.com/api/webhooks/698376560155295774/Y6mRFhV4ejOrBrMaauaV65y5RpAipR2jL7gRwDypMzSb5JllaXOcHCuc7pDEzqjERy6_';
const logger = Logger.getInstance();

/**
 * Enhanced PortfolioTracker with integrated balance monitoring
 */
export class PortfolioTracker extends EventEmitter {
  private static instance: PortfolioTracker;
  private trackedPositions: Map<string, TrackedPosition>;
  private currentBalances: Map<string, TokenBalance>;
  private accountSubscriptions: Map<string, number>;
  private readonly positionsFile: string;
  private credManager: CredentialsManager;
  private isInitialized: boolean = false;
  private initializationPromise: Promise<void> | null = null;
  private lastSolPrice: number = 0;
  private lastSolPriceTimestamp: number = 0;

  // Caches and flags for token metadata fetching
  private tokenMetadataCache: Map<string, { symbol: string; name: string }> = new Map();

  private constructor() {
    super();
    this.trackedPositions = new Map();
    this.currentBalances = new Map();
    this.accountSubscriptions = new Map();
    this.positionsFile = path.join(__dirname, '..', '..', 'portfolio-positions.json');
    this.credManager = CredentialsManager.getInstance();
    this.loadPositions();
  }

  public static getInstance(): PortfolioTracker {
    if (!PortfolioTracker.instance) {
      PortfolioTracker.instance = new PortfolioTracker();
    }
    return PortfolioTracker.instance;
  }

  /**
   * Main initialization method - only runs once, subsequent calls
   * return the same promise
   */
  public async initializeBalanceMonitoring(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    // If already initializing, return the existing promise
    if (this.initializationPromise) {
      return this.initializationPromise;
    }

    this.initializationPromise = this.doInitializeBalanceMonitoring();
    return this.initializationPromise;
  }

  /**
   * The actual implementation of the initialization
   * Protected by the public method to prevent multiple calls
   */
  private async doInitializeBalanceMonitoring(): Promise<void> {
    try {
      // Fetch initial balances for all tracked tokens
      const initialBalances = await this.fetchInitialBalances();

      // Set up monitoring for each token
      for (const [tokenAddress, data] of initialBalances.entries()) {
        await this.setupAccountMonitoring(
          this.credManager.getConnection(),
          data.accountAddress,
          tokenAddress, 
          data.decimals
        );

        // Update current balances map if needed
        if (!this.currentBalances.has(tokenAddress)) {
          this.currentBalances.set(tokenAddress, {
            currentTokens: data.balance,
            lastKnownTokens: data.balance,
            totalSold: 0,
            totalBought: 0,
            lastUpdated: Date.now()
          });
        } else {
          // Update existing balance info
          const existing = this.currentBalances.get(tokenAddress)!;
          existing.currentTokens = data.balance;
          existing.lastKnownTokens = data.balance;
          existing.lastUpdated = Date.now();
          this.currentBalances.set(tokenAddress, existing);
        }
      }

      // Save initial portfolio state
      this.savePositions();
      
      // Mark as initialized
      this.isInitialized = true;
      this.emit('initialized');

    } catch (error) {
      // Only log truly fatal errors
      if (!(error instanceof Error) || !error.message.includes('429')) {
        logger.error('PortfolioTracker', 'Balance monitoring initialization failed', error);
      }
      
      // Reset initialization flag so it can be retried
      this.initializationPromise = null;
      throw error;
    }
  }

  /**
   * Fetches initial token balances for all tracked positions
   */
  private async fetchInitialBalances(): Promise<Map<string, {
    balance: number,
    decimals: number,
    accountAddress: PublicKey
  }>> {
    const connection = this.credManager.getConnection();
    const wallet = this.credManager.getKeyPair();
    const balances = new Map();

    // Get all token accounts owned by wallet
    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
      wallet.publicKey,
      { programId: TOKEN_PROGRAM_ID }
    );

    // Process each token account
    for (const { pubkey, account } of tokenAccounts.value) {
      const parsedData = account.data as ParsedAccountData;
      const tokenAddress = parsedData.parsed.info.mint;

      // Only track tokens that are in our positions
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

    return balances;
  }

  /**
   * Set up monitoring for a specific token account
   */
  private async setupAccountMonitoring(
    connection: Connection,
    accountAddress: PublicKey,
    tokenAddress: string,
    decimals: number
  ): Promise<void> {
    // Remove existing subscription if any
    const existingSubscription = this.accountSubscriptions.get(tokenAddress);
    if (existingSubscription) {
      await connection.removeAccountChangeListener(existingSubscription);
    }

    // Set up new subscription
    const subscriptionId = connection.onAccountChange(
      accountAddress,
      async (accountInfo, context) => {
        try {
          // Get updated balance
          const tokenAccount = await getTokenAccount(connection, accountAddress);
          const newBalance = Number(tokenAccount.amount) / Math.pow(10, decimals);
          
          // Get current token price
          const currentPrice = await this.getCurrentTokenPrice(tokenAddress);
          
          // Process the update
          await this.handleBalanceChange(tokenAddress, newBalance, currentPrice);
        } catch (error) {
          // Silently handle rate limits
          if (!(error instanceof Error) || !error.message.includes('429')) {
            logger.error('PortfolioTracker', `Error processing account update for ${tokenAddress}`, error);
          }
        }
      },
      'confirmed'
    );

    // Save subscription ID for cleanup
    this.accountSubscriptions.set(tokenAddress, subscriptionId);
  }

  /**
   * Handles detecting buy/sell changes in token balances and updates totalBought or totalSold accordingly
   */
  private async handleBalanceChange(
    tokenAddress: string,
    newBalance: number,
    currentPrice: number
  ): Promise<void> {
    const balanceInfo = this.currentBalances.get(tokenAddress);
    const position = this.trackedPositions.get(tokenAddress);

    if (!balanceInfo || !position) return;

    const oldBalance = balanceInfo.lastKnownTokens;
    const balanceDiff = newBalance - oldBalance;

    // Prevent same balance change from triggering multiple times
    if (Math.abs(newBalance - balanceInfo.currentTokens) < 0.000001) return;

    // Add timestamp-based deduplication (5 second window)
    if (Date.now() - balanceInfo.lastUpdated < 5000) {
      return;
    }

    if (balanceDiff < 0) {
      // SELL logic - token balance decreased
      const soldAmount = Math.abs(balanceDiff);
      const soldValue = soldAmount * currentPrice;

      // Only update and notify if there's a meaningful change
      if (soldValue > 0.0001) {
        balanceInfo.totalSold += soldValue;

        // Emit balance change event
        this.emit('balanceChange', {
          tokenAddress,
          oldBalance,
          newBalance,
          change: balanceDiff,
          timestamp: new Date()
        });

        // Generate image and send to Discord for significant changes
        try {
          const positionData = await this.getPosition(tokenAddress);
          if (positionData) {
            // Force update with fresh price
            positionData.currentPriceSol = await this.getCurrentTokenPrice(tokenAddress);
            positionData.pnlPercentage = ((positionData.currentPriceSol - positionData.entryPriceSol) /
                                         positionData.entryPriceSol) * 100;

            await this.sendPositionToDiscord(positionData);
          }
        } catch (error) {
          logger.error('PortfolioTracker', `Failed to generate position image for ${tokenAddress}`, error);
        }
      }
    } else if (balanceDiff > 0.000001) {
      // BUY logic - token balance increased
      const boughtAmount = balanceDiff;
      const boughtValue = boughtAmount * currentPrice;
      balanceInfo.totalBought += boughtValue;

      // Emit balance change event
      this.emit('balanceChange', {
        tokenAddress,
        oldBalance,
        newBalance,
        change: balanceDiff,
        timestamp: new Date()
      });
    }

    // Update the record of current tokens & last-known
    balanceInfo.currentTokens = newBalance;
    balanceInfo.lastKnownTokens = newBalance;
    balanceInfo.lastUpdated = Date.now();
    this.currentBalances.set(tokenAddress, balanceInfo);

    this.savePositions();
  }

  /**
   * Utility method to send position updates to Discord
   */
  private async sendPositionToDiscord(position: Position): Promise<void> {
    // Import the ImageGenerator dynamically to handle the case where Sharp might not be available
    try {
      // Try to use the SVG generator first (which doesn't depend on Sharp)
      let imageGenerator;
      try {
        const { ImageGenerator } = await import('./imageGeneratorSvg');
        imageGenerator = ImageGenerator.getInstance();
        
        // SVG generator can accept just the position
        await imageGenerator.sendToDiscord(position);
      } catch (error) {
        // Fall back to the original ImageGenerator if SVG one fails
        const { ImageGenerator } = await import('./imageGenerator');
        imageGenerator = ImageGenerator.getInstance();
        
        // Original generator requires generating the image buffer first
        const imageBuffer = await imageGenerator.generatePositionImage(position);
        await imageGenerator.sendToDiscord(imageBuffer, position);
      }
      
      logger.success('PortfolioTracker', `Position for ${position.symbol} sent to Discord`);
    } catch (error) {
      logger.error('PortfolioTracker', `Failed to send position for ${position.symbol} to Discord`, error);
    }
  }

  /**
   * Explicitly initialize monitoring for a specific token
   * Called after buy transactions or when adding a new position
   */
  public async initializeTokenMonitoring(tokenAddress: string): Promise<void> {
    const connection = this.credManager.getConnection();
    const wallet = this.credManager.getKeyPair();

    try {
      const tokenMint = new PublicKey(tokenAddress);
      const tokenAccount = await getAssociatedTokenAddress(
        tokenMint,
        wallet.publicKey,
        false
      );

      // Get token account info
      const mintInfo = await connection.getParsedAccountInfo(tokenMint);
      const decimals = (mintInfo.value?.data as ParsedAccountData).parsed.info.decimals || 9;

      try {
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
        // If token account doesn't exist yet, that's okay - just skip monitoring setup
        logger.info('PortfolioTracker', `Token account for ${tokenAddress} doesn't exist yet`);
      }

    } catch (error) {
      logger.error('PortfolioTracker', `Error initializing monitoring for ${tokenAddress}`, error);
      throw error;
    }
  }

  /**
   * Initialize monitoring for a newly bought token
   */
  public async startMonitoring(connection: Connection, walletPublicKey: PublicKey, tokenAddress: string): Promise<void> {
    // First ensure the portfolio tracker is initialized
    await this.initializeBalanceMonitoring();
    
    // Now start monitoring this specific token
    await this.initializeTokenMonitoring(tokenAddress);
  }

  /**
   * Clean up all subscriptions - call this when shutting down
   */
  public async cleanup(): Promise<void> {
    const connection = this.credManager.getConnection();
    
    // Clean up all subscriptions
    for (const [tokenAddress, subscriptionId] of this.accountSubscriptions.entries()) {
      try {
        await connection.removeAccountChangeListener(subscriptionId);
      } catch (error) {
        logger.warn('PortfolioTracker', `Error removing listener for ${tokenAddress}`, error);
      }
    }
    
    this.accountSubscriptions.clear();
    this.savePositions(); // Save one last time
  }

  /**
   * Load positions from disk
   */
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
            // Validate the data before adding it
            if (!this.validatePositionData(data)) {
              logger.warn('PortfolioTracker', `Invalid position data for ${tokenAddress}, skipping`);
              continue;
            }

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
      logger.error('PortfolioTracker', 'Error loading positions', error);
      this.trackedPositions = new Map();
      this.currentBalances = new Map();
      fs.writeFileSync(this.positionsFile, JSON.stringify({}));
    }
  }

  /**
   * Validate position data before loading it
   */
  private validatePositionData(data: any): boolean {
    if (!data || typeof data !== 'object') return false;
    
    // Check position data
    if (!data.position || typeof data.position !== 'object') return false;
    if (typeof data.position.tokenAddress !== 'string') return false;
    if (isNaN(Number(data.position.initialBuyAmount))) return false;
    if (isNaN(Number(data.position.initialSolSpent))) return false;
    if (isNaN(Number(data.position.entryPrice))) return false;
    
    // Check balance info
    if (!data.balanceInfo || typeof data.balanceInfo !== 'object') return false;
    if (isNaN(Number(data.balanceInfo.currentTokens))) return false;
    if (isNaN(Number(data.balanceInfo.lastKnownTokens))) return false;
    
    return true;
  }

  /**
   * Save positions to disk
   */
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
      logger.error('PortfolioTracker', 'Error saving positions', error);
    }
  }

  /**
   * Get the current SOL price in USD from Jupiter with caching
   */
  public async getSolPriceUsd(): Promise<number> {
    // Use cached price if it's less than 5 minutes old
    const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes in milliseconds
    
    if (this.lastSolPrice > 0 && 
        (Date.now() - this.lastSolPriceTimestamp) < CACHE_DURATION) {
      return this.lastSolPrice;
    }
    
    try {
      const solResponse = await axios.get(
        'https://api.jup.ag/price/v2?ids=So11111111111111111111111111111111111111112'
      );
      const solData = solResponse.data.data['So11111111111111111111111111111111111111112'];
      const price = Number(solData.price) || 0;
      
      // Cache the price
      this.lastSolPrice = price;
      this.lastSolPriceTimestamp = Date.now();
      
      return price;
    } catch (error) {
      logger.warn('PortfolioTracker', 'Error fetching SOL price', error);
      // Return cached price if available, otherwise 0
      return this.lastSolPrice || 0;
    }
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
      // Fallback metadata with $ prefix
      const fallbackMeta = {
        symbol: `$${tokenAddress.slice(0, 4)}...${tokenAddress.slice(-4)}`,
        name: 'Unknown Token'
      };
      this.tokenMetadataCache.set(tokenAddress, fallbackMeta);
      return fallbackMeta;
    }
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
      return 0;
    }
  }

  /**
   * Get current token price - handles both pump tokens and regular tokens
   */
  public async getCurrentTokenPrice(tokenAddress: string): Promise<number> {
    try {
      const connection = this.credManager.getConnection();
      const tokenStatus = await isPumpFunToken(connection, tokenAddress);

      if (tokenStatus.isPump) {
        const pumpData = await this.getPumpTokenData(tokenAddress);
        if (pumpData) {
          return this.calculatePumpTokenPrice(pumpData);
        }
      }
      return await this.getJupiterPrice(tokenAddress);
    } catch (error) {
      // Fail silently and return 0 for price
      return 0;
    }
  }

  /**
   * Add a new position or update an existing one
   */
  public async addPosition(
    tokenAddress: string,
    solSpent: number,
    amount: number,
    txId: string,
    options: { entryPriceOverride?: number; isPumpToken?: boolean } = {}
  ): Promise<void> {
    // Initialize if not already done
    if (!this.isInitialized) {
      await this.initializeBalanceMonitoring();
    }

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

  /**
   * Force refresh a specific position's data
   */
  public async refreshPosition(tokenAddress: string): Promise<void> {
    // Skip if we're not tracking this position
    if (!this.trackedPositions.has(tokenAddress)) {
      return;
    }

    try {
      await this.initializeTokenMonitoring(tokenAddress);
      
      // Force update the position data with fresh price
      const position = await this.getPosition(tokenAddress);
      if (position) {
        const fresh = await this.getCurrentTokenPrice(tokenAddress);
        position.currentPriceSol = fresh;
        position.pnlPercentage = ((fresh - position.entryPriceSol) / position.entryPriceSol) * 100;
      }
    } catch (error) {
      logger.error('PortfolioTracker', `Error refreshing position for ${tokenAddress}`, error);
    }
  }

  /**
   * Get position data for a specific token
   */
  public async getPosition(tokenAddress: string): Promise<Position | null> {
    // Initialize if needed
    if (!this.isInitialized) {
      try {
        await this.initializeBalanceMonitoring();
      } catch (error) {
        logger.error('PortfolioTracker', `Failed to initialize for getPosition(${tokenAddress})`, error);
      }
    }

    const position = this.trackedPositions.get(tokenAddress);
    if (!position) return null;

    try {
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
          // If token account doesn't exist, create a placeholder
          this.currentBalances.set(tokenAddress, {
            currentTokens: 0,
            lastKnownTokens: 0,
            totalSold: 0,
            totalBought: 0,
            lastUpdated: Date.now()
          });
        }
      }

      const finalBalance = this.currentBalances.get(tokenAddress)!;
      // Even if we have 0 tokens, we still want to show sold amounts, so do NOT return null
      const currentValue = finalBalance.currentTokens * currentPrice;
      const totalValueBought = position.initialSolSpent + finalBalance.totalBought;
      
      // Avoid divide by zero
      const pnlPercentage = position.entryPrice > 0
        ? ((currentPrice - position.entryPrice) / position.entryPrice) * 100
        : 0;

      const tokenMetadata = await this.getTokenMetadata(tokenAddress);

      // Compute Net Profit in SOL and USD
      const netProfitSol = (currentValue + finalBalance.totalSold) - totalValueBought;
      const solPriceUsd = await this.getSolPriceUsd();
      const netProfitUsd = netProfitSol * solPriceUsd;

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
    } catch (error) {
      logger.error('PortfolioTracker', `Error fetching position for ${tokenAddress}`, error);
      return null;
    }
  }

  /**
   * Get all positions with summary data
   */
  public async getAllPositions(): Promise<PositionSnapshot> {
    // Initialize if needed
    if (!this.isInitialized) {
      try {
        await this.initializeBalanceMonitoring();
      } catch (error) {
        logger.error('PortfolioTracker', `Failed to initialize for getAllPositions()`, error);
      }
    }

    const positions: Position[] = [];
    let totalValue = 0;
    let totalInvestment = 0;

    for (const tokenAddress of this.trackedPositions.keys()) {
      try {
        const pos = await this.getPosition(tokenAddress);
        if (pos) {
          positions.push(pos);
          totalValue += pos.remainingValue;
          totalInvestment += pos.totalValueBought;
        }
      } catch (error) {
        logger.error('PortfolioTracker', `Error processing position for ${tokenAddress}`, error);
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

  /**
   * Display portfolio to console
   */
  public async displayPortfolio(connection?: Connection, walletPublicKey?: PublicKey): Promise<void> {
    if (!connection || !walletPublicKey) {
      connection = this.credManager.getConnection();
      walletPublicKey = this.credManager.getKeyPair().publicKey;
    }

    try {
      // Initialize if needed
      if (!this.isInitialized) {
        await this.initializeBalanceMonitoring();
      }

      // Get position data
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
        console.log(`Symbol: ${pos.symbol}`);

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
      logger.error('PortfolioTracker', 'Error displaying portfolio', error);
      throw error;
    }
  }

  /**
   * Force portfolio export to Discord
   */
  public async exportPortfolioToDiscord(): Promise<void> {
    try {
      // Get all positions
      const positionData = await this.getAllPositions();
      
      // Skip if no positions
      if (positionData.positions.length === 0) {
        console.log(chalk.hex(COLORS.PRIMARY)('No positions to export'));
        return;
      }
      
      // Send each position to Discord
      for (const position of positionData.positions) {
        try {
          await this.sendPositionToDiscord(position);
          console.log(chalk.hex(COLORS.SUCCESS)(`Exported position for ${position.symbol} to Discord`));
        } catch (error) {
          logger.error('PortfolioTracker', `Failed to export position for ${position.symbol}`, error);
        }
      }
    } catch (error) {
      logger.error('PortfolioTracker', 'Failed to export portfolio', error);
    }
  }
}

export default PortfolioTracker;