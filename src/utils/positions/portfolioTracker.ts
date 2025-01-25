//portfoliotracker.ts
import { Connection, PublicKey, ParsedAccountData, AccountInfo, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddress, getAccount as getTokenAccount } from "@solana/spl-token";
import { isPumpFunToken } from "../swaps/pumpSwap";
import { CredentialsManager } from "../../cli/utils/credentialsManager";
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import BN from 'bn.js';

interface PumpCoinData {
    bonding_curve: string;
    associated_bonding_curve: string;
    virtual_token_reserves: string;
    virtual_sol_reserves: string;
    completed?: boolean;
}

interface TrackedPosition {
    tokenAddress: string;
    initialBuyAmount: number;    // Amount of tokens initially bought
    initialSolSpent: number;     // Amount of SOL spent on initial buy
    entryPrice: number;          // Initial entry price in SOL per token
    timestamp: number;
    txId: string;
    isPumpToken?: boolean;
    lastKnownTokens?: number;    // Last known token balance for reference
}

interface TokenBalance {
    currentTokens: number;       // Current token balance
    lastKnownTokens: number;     // Previous token balance for comparison
    totalSold: number;           // Total SOL received from sales
    totalBought: number;         // Total SOL spent on buys (after initial)
    lastUpdated: number;         // Timestamp of last update
}

interface Position {
    tokenAddress: string;
    symbol: string;
    name: string;
    entryPriceSol: number;
    currentPriceSol: number;
    totalValueBought: number;    // Total value invested (initial + additional buys)
    totalValueSold: number;      // Total value received from sales
    remainingValue: number;      // Current value of remaining tokens
    pnlPercentage: number;
    isPumpToken: boolean;
    lastUpdated: number;
}

interface PositionSnapshot {
    positions: Position[];
    totalValue: number;
    totalPnl: number;
    totalPnlPercentage: number;
    lastUpdated: number;
}

export class PortfolioTracker {
    private static instance: PortfolioTracker;
    private trackedPositions: Map<string, TrackedPosition>;
    private currentBalances: Map<string, TokenBalance>;
    private accountSubscriptions: Map<string, number>;
    private readonly positionsFile: string;
    private credManager: CredentialsManager;
    private isInitialized: boolean = false;

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
      console.log('Fetching initial balances...');
      const connection = this.credManager.getConnection();
      const wallet = this.credManager.getKeyPair();
      const balances = new Map();

      try {
          // Get all token accounts in one call
          const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
              wallet.publicKey,
              { programId: TOKEN_PROGRAM_ID }
          );

          // Process each token account that we're tracking
          for (const { pubkey, account } of tokenAccounts.value) {
              const parsedData = account.data as ParsedAccountData;
              const tokenAddress = parsedData.parsed.info.mint;

              if (this.trackedPositions.has(tokenAddress)) {
                  const decimals = parsedData.parsed.info.tokenAmount.decimals;
                  const rawBalance = parsedData.parsed.info.tokenAmount.amount;
                  const adjustedBalance = Number(rawBalance) / Math.pow(10, decimals);

                  console.log(`Initial balance for ${tokenAddress}:`, {
                      raw: rawBalance,
                      adjusted: adjustedBalance,
                      decimals
                  });

                  balances.set(tokenAddress, {
                      balance: adjustedBalance,
                      decimals,
                      accountAddress: pubkey
                  });
              }
          }
      } catch (error) {
          console.error('Error fetching initial balances:', error);
          throw error;
      }

      return balances;
  }

  public getCurrentBalances(): Map<string, TokenBalance> {
    if (!this.isInitialized) {
        console.warn('Getting balances before initialization. Consider calling initializeBalanceMonitoring first.');
    }
    return this.currentBalances;
}

public getCurrentBalance(tokenAddress: string): TokenBalance | undefined {
    if (!this.isInitialized) {
        console.warn('Getting balance before initialization. Consider calling initializeBalanceMonitoring first.');
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
                    // Load position data
                    this.trackedPositions.set(tokenAddress, {
                        ...data.position,
                        initialBuyAmount: Number(data.position.initialBuyAmount),
                        initialSolSpent: Number(data.position.initialSolSpent),
                        entryPrice: Number(data.position.entryPrice)
                    });

                    // Load balance data
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
        console.error('Error loading positions:', error);
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
      console.error('Error saving positions:', error);
  }
}

private async handleBalanceChange(
  tokenAddress: string,
  newBalance: number,
  currentPrice: number
) {
  const balanceInfo = this.currentBalances.get(tokenAddress);
  const position = this.trackedPositions.get(tokenAddress);
  
  if (!balanceInfo || !position) {
      console.log(`No balance info or position found for ${tokenAddress}`);
      return;
  }

  const oldBalance = balanceInfo.lastKnownTokens;
  const balanceDiff = newBalance - oldBalance;

  console.log(`Processing balance change for ${tokenAddress}:`, {
      oldBalance,
      newBalance,
      difference: balanceDiff,
      currentPrice
  });

  // Update running totals based on balance change
  if (balanceDiff < 0) {
      // Token amount decreased - it's a sell
      const soldAmount = Math.abs(balanceDiff);
      const soldValue = soldAmount * currentPrice;
      balanceInfo.totalSold += soldValue;
      console.log(`Sell detected:`, {
          soldAmount,
          soldValue,
          currentPrice,
          newTotalSold: balanceInfo.totalSold
      });
  } else if (balanceDiff > 0) {
      // Token amount increased after initial buy - it's an additional buy
      const boughtAmount = balanceDiff;
      const boughtValue = boughtAmount * currentPrice;
      balanceInfo.totalBought += boughtValue;
      console.log(`Buy detected:`, {
          boughtAmount,
          boughtValue,
          currentPrice,
          newTotalBought: balanceInfo.totalBought
      });
  }

  // Update the current balance information
  balanceInfo.currentTokens = newBalance;
  balanceInfo.lastKnownTokens = newBalance;
  balanceInfo.lastUpdated = Date.now();

  // Save updated balances immediately
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
            if (!data.bonding_curve || !data.associated_bonding_curve) {
                return null;
            }
            return data;
        } catch (error) {
            console.error('Error fetching pump token data:', error);
            return null;
        }
    }

    private calculatePumpTokenPrice(coinData: PumpCoinData): number {
        try {
            const virtualTokenReserves = new BN(coinData.virtual_token_reserves);
            const virtualSolReserves = new BN(coinData.virtual_sol_reserves);

            if (virtualTokenReserves.isZero() || virtualSolReserves.isZero()) {
                return 0;
            }

            const reserves_ratio = Number(virtualSolReserves.toString()) / Number(virtualTokenReserves.toString());
            return reserves_ratio / 1000;
        } catch (error) {
            console.error('Error calculating pump token price:', error);
            return 0;
        }
    }

    private async getJupiterPrice(tokenAddress: string): Promise<number> {
        try {
            const solResponse = await axios.get(
                'https://api.jup.ag/price/v2?ids=So11111111111111111111111111111111111111112'
            );
            const solPriceUSD = Number(solResponse.data.data.So11111111111111111111111111111111111111112.price);

            const tokenResponse = await axios.get(
                `https://api.jup.ag/price/v2?ids=${tokenAddress}`
            );
            const tokenData = tokenResponse.data.data[tokenAddress];
            if (!tokenData) return 0;

            const tokenPriceUSD = Number(tokenData.price) || 0;
            const tokenPriceSOL = tokenPriceUSD / solPriceUSD;
            return tokenPriceSOL;
        } catch (error) {
            console.error('Error fetching Jupiter price:', error);
            return 0;
        }
    }

    public async initializeBalanceMonitoring(): Promise<void> {
        if (this.isInitialized) {
            console.log('Balance monitoring already initialized');
            return;
        }
    
        console.log('Starting balance monitoring initialization...');
    
        try {
            // First, fetch all initial balances
            const initialBalances = await this.fetchInitialBalances();
            console.log(`Fetched initial balances for ${initialBalances.size} tokens`);
    
            // Initialize monitoring for each token
            for (const [tokenAddress, { balance, decimals, accountAddress }] of initialBalances) {
                console.log(`Initializing monitoring for ${tokenAddress}`);
                await this.initializeTokenMonitoring(tokenAddress);
            }
    
            this.isInitialized = true;
            console.log('Balance monitoring initialization complete');
    
        } catch (error) {
            console.error('Error during balance monitoring initialization:', error);
            throw error;
        }
    }

  private async setupAccountMonitoring(
    connection: Connection,
    accountAddress: PublicKey,
    tokenAddress: string,
    decimals: number
) {
    // Remove existing subscription if any
    const existingSubscription = this.accountSubscriptions.get(tokenAddress);
    if (existingSubscription) {
        await connection.removeAccountChangeListener(existingSubscription);
        console.log(`Removed existing subscription for ${tokenAddress}`);
    }

    console.log(`Setting up monitoring for ${tokenAddress} at ${accountAddress.toString()}`);

    const subscriptionId = connection.onAccountChange(
        accountAddress,
        async (accountInfo: AccountInfo<Buffer>, context) => {
            try {
                // Get the token account info
                const tokenAccount = await getTokenAccount(connection, accountAddress);
                const newBalance = Number(tokenAccount.amount) / Math.pow(10, decimals);
                const currentPrice = await this.getCurrentTokenPrice(tokenAddress);
                
                console.log(`Account update received for ${tokenAddress}:`, {
                    slot: context.slot,
                    rawBalance: tokenAccount.amount,
                    adjustedBalance: newBalance,
                    currentPrice
                });
                
                await this.handleBalanceChange(tokenAddress, newBalance, currentPrice);
            } catch (error) {
                console.error(`Error processing account update for ${tokenAddress}:`, error);
            }
        },
        'confirmed'
    );

    this.accountSubscriptions.set(tokenAddress, subscriptionId);
    console.log(`Monitoring set up for ${tokenAddress} with subscription ID ${subscriptionId}`);
}

public async addPosition(
    tokenAddress: string,
    solSpent: number,
    amount: number,
    txId: string,
    options: { entryPriceOverride?: number; isPumpToken?: boolean } = {}
): Promise<void> {
    console.log('Adding position:', {
        tokenAddress,
        solSpent,
        amount,
        options
    });

    const existingPosition = this.trackedPositions.get(tokenAddress);
    const existingBalance = this.currentBalances.get(tokenAddress);

    if (existingPosition) {
        console.log('Updating existing position:', {
            oldSolSpent: existingPosition.initialSolSpent,
            additionalSpent: solSpent,
            oldAmount: existingPosition.initialBuyAmount,
            additionalAmount: amount
        });

        if (existingBalance) {
            existingBalance.lastUpdated = Date.now();
        }
    } else {
        console.log('Creating new position');
        // This is a new position
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
        
        // Initialize balance tracking for new position
        this.currentBalances.set(tokenAddress, {
            currentTokens: amount,
            lastKnownTokens: amount,
            totalSold: 0,
            totalBought: 0,
            lastUpdated: Date.now()
        });
    }

    // Save position data
    this.savePositions();

    // Immediately fetch current balance and set up monitoring for this specific token
    await this.initializeTokenMonitoring(tokenAddress);
}

public async initializeTokenMonitoring(tokenAddress: string): Promise<void> {
    console.log(`Initializing monitoring for token: ${tokenAddress}`);
    const connection = this.credManager.getConnection();
    const wallet = this.credManager.getKeyPair();

    try {
        // Get the token account address
        const tokenAccount = await getAssociatedTokenAddress(
            new PublicKey(tokenAddress),
            wallet.publicKey,
            false
        );

        // Fetch token mint info to get decimals
        const mintInfo = await connection.getParsedAccountInfo(new PublicKey(tokenAddress));
        const decimals = (mintInfo.value?.data as ParsedAccountData).parsed.info.decimals || 9;

        // Get current balance
        const accountInfo = await getTokenAccount(connection, tokenAccount);
        const currentTokens = Number(accountInfo.amount) / Math.pow(10, decimals);

        console.log(`Current balance for ${tokenAddress}:`, {
            raw: accountInfo.amount,
            adjusted: currentTokens,
            decimals
        });

        // Update balance tracking
        this.currentBalances.set(tokenAddress, {
            currentTokens,
            lastKnownTokens: currentTokens,
            totalSold: this.currentBalances.get(tokenAddress)?.totalSold || 0,
            totalBought: this.currentBalances.get(tokenAddress)?.totalBought || 0,
            lastUpdated: Date.now()
        });

        // Use existing setupAccountMonitoring for consistency
        await this.setupAccountMonitoring(
            connection,
            tokenAccount,
            tokenAddress,
            decimals
        );

    } catch (error) {
        console.error(`Error initializing monitoring for ${tokenAddress}:`, error);
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
      const currentBalance = this.currentBalances.get(tokenAddress);
      
      if (!currentBalance) {
          const connection = this.credManager.getConnection();
          const wallet = this.credManager.getKeyPair();
          const tokenAccount = await getAssociatedTokenAddress(
              new PublicKey(tokenAddress), 
              wallet.publicKey
          );
          
          try {
              // Get the token account info
              const accountInfo = await getTokenAccount(connection, tokenAccount);
              
              // Get the mint account info to fetch decimals
              const mintInfo = await connection.getParsedAccountInfo(new PublicKey(tokenAddress));
              const decimals = (mintInfo.value?.data as ParsedAccountData).parsed.info.decimals || 9;
              
              const currentTokens = Number(accountInfo.amount) / Math.pow(10, decimals);
              
              // If balance is 0, don't create a position
              if (currentTokens === 0) {
                  return null;
              }
              
              this.currentBalances.set(tokenAddress, {
                  currentTokens,
                  lastKnownTokens: currentTokens,
                  totalSold: 0,
                  totalBought: 0,
                  lastUpdated: Date.now()
              });
          } catch (error) {
              console.error(`Error fetching current balance for ${tokenAddress}:`, error);
              return null;
          }
      }
  
      const balanceInfo = this.currentBalances.get(tokenAddress)!;
      
      // If current balance is 0, return null
      if (balanceInfo.currentTokens === 0) {
          return null;
      }
  
      const currentValue = balanceInfo.currentTokens * currentPrice;
      const totalValueBought = position.initialSolSpent + balanceInfo.totalBought;
      const pnlPercentage = ((currentPrice - position.entryPrice) / position.entryPrice) * 100;
  
      return {
          tokenAddress,
          symbol: tokenAddress.slice(0, 8) + '...',
          name: position.isPumpToken ? 'Pump Token' : 'Standard Token',
          entryPriceSol: position.entryPrice,
          currentPriceSol: currentPrice,
          totalValueBought,
          totalValueSold: balanceInfo.totalSold,
          remainingValue: currentValue,
          pnlPercentage,
          isPumpToken: position.isPumpToken ?? false,
          lastUpdated: Date.now()
      };
  }

    public async getAllPositions(): Promise<PositionSnapshot> {
      const positions: Position[] = [];
      let totalValue = 0;
      let totalInvestment = 0;

      for (const tokenAddress of this.trackedPositions.keys()) {
          const position = await this.getPosition(tokenAddress);
          if (position) {
              positions.push(position);
              totalValue += position.remainingValue;
              totalInvestment += position.totalValueBought;
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
                async ([tokenAddress, _]) => await this.getPosition(tokenAddress)
            )
        );

        // Filter out null positions (zero balances)
        const activePositions = positions.filter((pos): pos is Position => pos !== null);

        if (activePositions.length === 0) {
            console.log('\nNo active positions found.\n');
            return;
        }

        console.log('\n=== Token Positions ===\n');
        
        for (const pos of activePositions) {
            console.log(`Token Address: ${pos.tokenAddress}`);

            if (pos.isPumpToken) {
                console.log(`Entry Price: ${pos.entryPriceSol.toExponential(9)} SOL`);
                console.log(`Current Price: ${pos.currentPriceSol.toExponential(9)} SOL`);
            } else {
                console.log(`Entry Price: ${pos.entryPriceSol.toFixed(9)} SOL`);
                console.log(`Current Price: ${pos.currentPriceSol.toFixed(9)} SOL`);
            }

            const formatSol = (amount: number) => 
                amount < 0.001 ? amount.toFixed(6) : amount.toFixed(4);

            // For display, add initial investment and additional buys
            const totalInvested = pos.totalValueBought;
            console.log(`Total Invested: ${formatSol(totalInvested)} SOL`);
            console.log(`Total Sold: ${formatSol(pos.totalValueSold)} SOL`);
            console.log(`Remaining Value: ${formatSol(pos.remainingValue)} SOL`);

            const pnlColor = pos.pnlPercentage >= 0 ? '\x1b[32m' : '\x1b[31m';
            console.log(
                `Total PNL: ${pnlColor}${pos.pnlPercentage.toFixed(2)}%\x1b[0m`
            );
            console.log('---');
        }
        
        console.log(`\nLast Updated: ${new Date().toLocaleString()}\n`);

    } catch (error) {
        console.error('Error displaying portfolio:', error);
        throw error;
    }
}
}

export default PortfolioTracker;