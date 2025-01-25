//swapBuilder.ts
import { 
  TransactionInstruction,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, AccountLayout } from "@solana/spl-token";
import BN from 'bn.js';
import { ComputeBudgetProgram } from "@solana/web3.js";

interface PoolAccounts {
  ammId: PublicKey;
  ammAuthority: PublicKey;
  ammOpenOrders: PublicKey;
  ammTargetOrders: PublicKey;
  poolCoinTokenAccount: PublicKey;
  poolPcTokenAccount: PublicKey;
  serumProgramId: PublicKey;
  serumMarket: PublicKey;
  serumBids: PublicKey;
  serumAsks: PublicKey;
  serumEventQueue: PublicKey;
  serumCoinVaultAccount: PublicKey;
  serumPcVaultAccount: PublicKey;
  serumVaultSigner: PublicKey;
}

// Pre-computed instructions
const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");
const createWSOLAccountInstruction = (wallet: PublicKey, wsolAccount: PublicKey) => 
  SystemProgram.createAccount({
    fromPubkey: wallet,
    newAccountPubkey: wsolAccount,
    lamports: LAMPORTS_PER_SOL,
    space: AccountLayout.span,
    programId: TOKEN_PROGRAM_ID
  });

const computeBudgetIx = ComputeBudgetProgram.setComputeUnitLimit({
  units: 1_400_000
});

// Pre-allocated buffer
const BUFFER_SIZE = 1024;
const transactionBuffer = Buffer.alloc(BUFFER_SIZE);

export async function buildSwapInstruction(
  wallet: PublicKey,
  userSourceTokenAccount: PublicKey,
  userDestinationTokenAccount: PublicKey,
  pool: PoolAccounts,
  amountIn: BN,
  minAmountOut: BN,
  silent: boolean = false
): Promise<TransactionInstruction> {
  try {
      // Raydium V4 program ID
      const RAYDIUM_V4_PROGRAM_ID = new PublicKey("675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8");

      // Set up the instruction data for SwapBaseIn
      const data = Buffer.from([
          9,  // SwapBaseIn instruction discriminator
          ...amountIn.toArray("le", 8),
          ...minAmountOut.toArray("le", 8)
      ]);

      return new TransactionInstruction({
          programId: RAYDIUM_V4_PROGRAM_ID,
          keys: [
              { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
              { pubkey: pool.ammId, isSigner: false, isWritable: true },
              { pubkey: pool.ammAuthority, isSigner: false, isWritable: false },
              { pubkey: pool.ammOpenOrders, isSigner: false, isWritable: true },
              { pubkey: pool.ammTargetOrders, isSigner: false, isWritable: true },
              { pubkey: pool.poolCoinTokenAccount, isSigner: false, isWritable: true },
              { pubkey: pool.poolPcTokenAccount, isSigner: false, isWritable: true },
              { pubkey: pool.serumProgramId, isSigner: false, isWritable: false },
              { pubkey: pool.serumMarket, isSigner: false, isWritable: true },
              { pubkey: pool.serumBids, isSigner: false, isWritable: true },
              { pubkey: pool.serumAsks, isSigner: false, isWritable: true },
              { pubkey: pool.serumEventQueue, isSigner: false, isWritable: true },
              { pubkey: pool.serumCoinVaultAccount, isSigner: false, isWritable: true },
              { pubkey: pool.serumPcVaultAccount, isSigner: false, isWritable: true },
              { pubkey: pool.serumVaultSigner, isSigner: false, isWritable: false },
              { pubkey: userSourceTokenAccount, isSigner: false, isWritable: true },
              { pubkey: userDestinationTokenAccount, isSigner: false, isWritable: true },
              { pubkey: wallet, isSigner: true, isWritable: false }
          ],
          data
      });
  } catch (error) {
      if (!silent) {
          console.error('Error building swap instruction:', error);
      }
      throw error;
  }
}

export { createWSOLAccountInstruction, computeBudgetIx, transactionBuffer };