// src/copytrading/types/types.ts

import { PublicKey } from "@solana/web3.js";
import { CommitmentLevel } from "@triton-one/yellowstone-grpc";

/**
 * Identifies the swap protocol or type.
 */
export enum SwapType {
  RAYDIUM = "raydium",
  PUMP = "pump",
  UNKNOWN = "unknown",
}

/**
 * Base interface for swap data across any protocol.
 */
export interface BaseSwapData {
  swapType: SwapType;       // Which protocol was detected
  tokenAddress: PublicKey;  // The token mint involved in the swap
  amountIn?: number;        // The input amount (lamports or token quantity)
  slippage?: number;        // Optional: store desired slippage
  signature?: string;       // Transaction signature
  programId?: string;       // Program ID that processed the swap
  tokenInMint?: string;     // Input token mint address
  tokenOutMint?: string;    // Output token mint address
  amountOut?: number;       // The output amount
  timestamp?: Date;         // When the swap occurred
  success?: boolean;        // Whether the swap was successful
  walletAddress?: string;   // The wallet that initiated the swap
}

export interface RaydiumSwapData extends BaseSwapData {
  swapType: SwapType.RAYDIUM;
  isBuy?: boolean;
  // Raydium accounts and program references
  poolCoinTokenAccount: PublicKey;
  poolPcTokenAccount: PublicKey;
  poolLpTokenAccount: PublicKey;
  ammAuthority: PublicKey;
  ammId: PublicKey;
  ammOpenOrders: PublicKey;
  ammTargetOrders: PublicKey;
  poolTempLpTokenAccount: PublicKey;
  serumProgramId: PublicKey;
  serumMarket: PublicKey;
  serumBids: PublicKey;
  serumAsks: PublicKey;
  serumEventQueue: PublicKey;
  serumBaseVault: PublicKey;
  serumQuoteVault: PublicKey;
  serumOpenOrders: PublicKey;
  rayLogData?: string;     // Raydium-specific log data
  signature?: string;      // Transaction signature
  programId?: string;      // Program ID that processed the swap
  tokenInMint?: string;    // Input token mint address
  tokenOutMint?: string;   // Output token mint address
  timestamp?: Date;        // When the swap occurred
  success?: boolean;       // Whether the swap was successful
  walletAddress?: string;  // The wallet that initiated the swap

  // Optional: track pool and user account balances
  poolBalances?: {
    coin: {
      pre: number;
      post: number;
      decimals: number;
    };
    pc: {
      pre: number;
      post: number;
      decimals: number;
    };
  };
  userAccounts?: Record<string, {
    exists: boolean;
    isATA: boolean;
    preBalance: number;
    postBalance: number;
    decimals: number;
    mint: string;
  }>;
  slot?: string;

  // ADDED: store decimals of the input and output tokens for exact copying
  decimalsIn?: number;
  decimalsOut?: number;
}

/**
 * Pump.fun-specific swap data, capturing relevant accounts
 */
export interface PumpSwapData extends BaseSwapData {
  swapType: SwapType.PUMP;
  bondingCurve: PublicKey;
  associatedBondingCurve: PublicKey;
  virtualTokenReserves: string;    // Virtual token reserves from bonding curve
  virtualSolReserves: string;      // Virtual SOL reserves from bonding curve
  isBuy: boolean;                  // Whether this is a buy or sell
  userTokenAccount?: PublicKey;    // User's token account for this token
  decimalsIn?: number;             // Decimals of input token (9 for SOL, 6 for pump tokens)
  decimalsOut?: number;            // Decimals of output token (6 for pump tokens, 9 for SOL)
}

/**
 * Unified type capturing either a Raydium swap or a Pump.fun swap
 */
export type ParsedSwapData = RaydiumSwapData | PumpSwapData;

/**
 * Basic transaction validation result
 */
export interface ValidationResult {
  isValid: boolean;
  reason?: string;
}

/**
 * Configuration describing how we monitor transactions via gRPC
 */
export interface TransactionMonitorConfig {
  grpcEndpoint: string;      // gRPC endpoint
  xToken?: string;           // Optional token for private RPC endpoints
  commitment?: CommitmentLevel;

  // A list of wallet addresses (PubKey strings) that we want to watch for trades
  wallets: string[];

  // Optional swap constraints
  maxSlippage?: number;      
  minSolAmount?: number;     
  maxSolAmount?: number;     

  enablePump?: boolean;      // Whether to allow Pump.fun swaps
  enableRaydium?: boolean;   // Whether to allow Raydium swaps
}

/**
 * Basic tracking structure for monitoring stats
 */
export interface MonitorStatus {
  isActive: boolean;
  connectedAt?: Date;
  lastTransactionAt?: Date;
  processedTransactions: number;
  detectedSwaps: number;
  successfulCopies: number;
  failedCopies: number;
}

/**
 * Error representation for swap failures or parse failures
 */
export interface SwapError {
  type: "PARSE_ERROR" | "EXECUTION_ERROR" | "VALIDATION_ERROR";
  message: string;
  transaction?: string;
  timestamp: Date;
}
