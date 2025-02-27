// src/index.ts - Main application entry point
import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { isPumpFunToken, swapSolToPumpToken } from './utils/swaps/pumpSwap';
import { swapSolToToken, swapTokenToSol } from './utils/swaps/regularSwap';
import { PortfolioTracker } from './utils/positions/portfolioTracker';
import { CredentialsManager } from "./cli/utils/credentialsManager";
import { Logger, LogLevel } from "./cli/utils/logger";
import { ConnectionPool } from "./utils/connection/connectionPool";
import { BlockhashManager } from "./utils/swaps/blockhashManager";
import chalk from 'chalk';
import { COLORS } from './cli/config';

// Configure global settings
const MIN_SOL_REQUIRED = 0.001;
const BUFFER_SOL = 0.01;
const MAX_RETRIES = 3;
const RETRY_DELAY = 1000;

// Initialize logger
const logger = Logger.getInstance();
logger.initialize({
  logLevel: LogLevel.INFO,
  logToFile: true
});

// Initialize connection pool and other global services
export const initializeServices = async (): Promise<void> => {
  // Suppress warnings
  process.removeAllListeners('warning');
  
  try {
    logger.info('App', 'Initializing services...');
    const credManager = CredentialsManager.getInstance();
    
    if (!credManager.hasBasicCredentials()) {
      logger.error('App', 'Credentials not configured');
      throw new Error("Credentials not configured. Please set up RPC URL and private key in settings first.");
    }
    
    // Initialize connection pool
    const connPool = ConnectionPool.getInstance();
    connPool.initialize();
    
    // Get a connection and initialize BlockhashManager
    const connection = connPool.getConnection();
    BlockhashManager.getInstance().initialize(connection);
    
    // Initialize portfolio tracker
    await PortfolioTracker.getInstance().initializeBalanceMonitoring();
    
    logger.success('App', 'Services initialized successfully');
    return;
  } catch (error: unknown) {
    logger.error('App', 'Failed to initialize services', error);
    if (error instanceof Error) {
      throw error;
    }
    throw new Error("An unknown error occurred during initialization");
  }
};

// Main setup function to get connection and wallet
export const setupConnection = async () => {
  try {
    await initializeServices();
    const credManager = CredentialsManager.getInstance();
    const connection = ConnectionPool.getInstance().getConnection();
    const wallet = credManager.getKeyPair();
    
    return { connection, wallet };
  } catch (error: unknown) {
    logger.error('App', 'Failed to set up connection', error);
    if (error instanceof Error) {
      throw new Error(`Failed to setup connection: ${error.message}`);
    }
    throw new Error("Failed to setup connection: Unknown error");
  }
};

// Display portfolio positions
export const displayPositions = async (connection?: Connection): Promise<void> => {
  if (!connection) {
    const setup = await setupConnection();
    connection = setup.connection;
  }
  
  try {
    const { wallet } = await setupConnection();
    const tracker = PortfolioTracker.getInstance();
    await tracker.displayPortfolio(connection, wallet.publicKey);
  } catch (error: unknown) {
    logger.error('Portfolio', 'Failed to display positions', error);
    if (error instanceof Error) {
      throw error;
    }
    throw new Error("Failed to display portfolio positions");
  }
};

// Initialize swap environment
export const initializeSwapEnvironment = async (tokenAddress: string) => {
  const tokenPublicKey = new PublicKey(tokenAddress);
  const { connection, wallet } = await setupConnection();
  
  try {
    const [walletBalance, tokenInfo] = await Promise.all([
      connection.getBalance(wallet.publicKey),
      tokenAddress.endsWith('pump') ? 
        isPumpFunToken(connection, tokenPublicKey) : 
        Promise.resolve({ isPump: false, hasMigrated: false })
    ]);

    return { connection, wallet, tokenInfo, tokenPublicKey, walletBalance };
  } catch (error: unknown) {
    logger.error('Swap', `Failed to initialize swap environment for ${tokenAddress}`, error);
    if (error instanceof Error) {
      throw error;
    }
    throw new Error(`Failed to initialize swap environment for ${tokenAddress}`);
  }
};

// Handler for buy operations
export const handleBuyOperation = async (
  connection: Connection,
  wallet: Keypair,
  tokenPublicKey: PublicKey,
  tokenInfo: { isPump: boolean; hasMigrated: boolean },
  amountInSol: number = MIN_SOL_REQUIRED
): Promise<string> => {
  let retryCount = MAX_RETRIES;
  let lastError: Error | null = null;

  while (retryCount > 0) {
    try {
      const signature = tokenInfo.isPump && !tokenInfo.hasMigrated ?
        await swapSolToPumpToken(connection, wallet, tokenPublicKey, amountInSol, 0.01) :
        await swapSolToToken(connection, wallet, tokenPublicKey, amountInSol * LAMPORTS_PER_SOL, 0.01);
      
      logger.success('Buy', `Transaction successful: https://solscan.io/tx/${signature}`);
      return signature;
    } catch (error: unknown) {
      if (error instanceof Error) {
        lastError = error;
        logger.warn('Buy', `Attempt failed (${MAX_RETRIES - retryCount + 1}/${MAX_RETRIES})`, error.message);
        
        const isRetryableError = [
          "exceeded",
          "blockhash not found",
          "Transaction simulation failed",
          "Socket hang up"
        ].some(msg => error.message.includes(msg));

        if (isRetryableError && retryCount > 1) {
          retryCount--;
          await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
          continue;
        }
        
        throw formatError(error);
      } else {
        // For non-Error objects
        lastError = new Error("Unknown error occurred during buy operation");
        logger.warn('Buy', `Attempt failed (${MAX_RETRIES - retryCount + 1}/${MAX_RETRIES}) with unknown error`);
        
        if (retryCount > 1) {
          retryCount--;
          await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
          continue;
        }
        
        throw lastError;
      }
    }
  }
  
  throw lastError || new Error("Operation failed after maximum retries");
};

// Handler for sell operations
export const handleSellOperation = async (
  connection: Connection,
  wallet: Keypair,
  tokenPublicKey: PublicKey,
  percentageToSell: number
): Promise<string> => {
  try {
    const signature = await swapTokenToSol(
      connection,
      wallet,
      tokenPublicKey,
      percentageToSell,
      0.01
    );
    
    logger.success('Sell', `Transaction successful: https://solscan.io/tx/${signature}`);
    return signature;
  } catch (error: unknown) {
    logger.error('Sell', 'Failed to sell token', error);
    if (error instanceof Error) {
      throw formatError(error);
    }
    throw new Error("Failed to sell token: Unknown error");
  }
};

// Format errors for better user experience
function formatError(error: Error): Error {
  const errorMessages: Record<string, string> = {
    "No liquidity pool found": "No liquidity pool exists for this token pair",
    "insufficient funds": "Insufficient funds for swap",
    "exceeds desired slippage limit": "Price impact too high. Try increasing slippage tolerance or reducing amount",
    "0x1": "Transaction failed - check token contract and pool status",
    "TooLittleSolReceived": "Price impact too high. Try reducing amount or increasing slippage tolerance",
    "BondingCurveComplete": "This token has already migrated to Raydium"
  };

  const message = error.message || String(error);
  for (const [key, value] of Object.entries(errorMessages)) {
    if (message.includes(key)) return new Error(value);
  }
  
  return error;
}

// Graceful shutdown handler
export const shutdown = async (): Promise<void> => {
  try {
    logger.info('App', 'Shutting down...');
    
    // Cleanup portfolio tracker
    await PortfolioTracker.getInstance().cleanup();
    
    // Cleanup blockhash manager
    BlockhashManager.getInstance().cleanup();
    
    // Cleanup connection pool
    ConnectionPool.getInstance().cleanup();
    
    logger.success('App', 'Shutdown completed successfully');
  } catch (error: unknown) {
    logger.error('App', 'Error during shutdown', error);
  }
};

// Handle process termination signals
process.on('SIGINT', async () => {
  console.log(chalk.hex(COLORS.PRIMARY)("\nReceived SIGINT, shutting down..."));
  await shutdown();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log(chalk.hex(COLORS.PRIMARY)("\nReceived SIGTERM, shutting down..."));
  await shutdown();
  process.exit(0);
});

// Export commands for use in CLI
export { swapSolToToken, swapTokenToSol, swapSolToPumpToken };

// Command-line interface entry point
if (require.main === module) {
  (async () => {
    try {
      const command = process.argv[2];
      if (!command) {
        console.error(chalk.hex(COLORS.ERROR)("Usage:\nnpm start <token-address> (buy)\nnpm start sell <token-address> <percentage> (sell)\nnpm start positions (view)"));
        process.exit(1);
      }

      await initializeServices();

      if (command === "positions") {
        await displayPositions();
        await shutdown();
        return;
      }

      if (command === "sell") {
        const tokenAddress = process.argv[3];
        const percentage = parseFloat(process.argv[4]);
        
        if (!tokenAddress || isNaN(percentage) || percentage <= 0 || percentage > 100) {
          console.error(chalk.hex(COLORS.ERROR)("Usage: npm start sell <token-address> <percentage>"));
          process.exit(1);
        }
        
        const { connection, wallet } = await setupConnection();
        await handleSellOperation(connection, wallet, new PublicKey(tokenAddress), percentage);
        await shutdown();
        return;
      }

      // Default to buy operation
      const { connection, wallet, tokenInfo, tokenPublicKey, walletBalance } = 
        await initializeSwapEnvironment(command);

      const requiredBalance = (MIN_SOL_REQUIRED + BUFFER_SOL) * LAMPORTS_PER_SOL;
      if (walletBalance < requiredBalance) {
        throw new Error(
          `Insufficient SOL balance. Required: ${(requiredBalance / LAMPORTS_PER_SOL).toFixed(3)} SOL, ` +
          `Current: ${(walletBalance / LAMPORTS_PER_SOL).toFixed(3)} SOL`
        );
      }

      await handleBuyOperation(connection, wallet, tokenPublicKey, tokenInfo);
      await shutdown();

    } catch (error: unknown) {
      if (error instanceof Error) {
        if (error.message.includes("Invalid public key input")) {
          logger.error('App', "Invalid token address format");
          console.error(chalk.hex(COLORS.ERROR)("Invalid token address format"));
        } else {
          logger.error('App', error.message);
          console.error(chalk.hex(COLORS.ERROR)(error.message));
        }
      } else {
        logger.error('App', 'Unknown error occurred');
        console.error(chalk.hex(COLORS.ERROR)("An unknown error occurred"));
      }
      
      await shutdown();
      process.exit(1);
    }
  })();
}

export default { setupConnection, displayPositions, handleBuyOperation, handleSellOperation };