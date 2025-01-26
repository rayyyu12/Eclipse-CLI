// -------------------------------------------------------------
// pumpCopySwap.ts (updated to always use createAssociatedTokenAccountIdempotentInstruction)
// -------------------------------------------------------------
import {
    Connection,
    Keypair,
    TransactionMessage,
    VersionedTransaction,
    ComputeBudgetProgram,
    PublicKey,
    TransactionInstruction,
    SystemProgram,
    LAMPORTS_PER_SOL,
    SYSVAR_RENT_PUBKEY
} from "@solana/web3.js";
import {
    getAssociatedTokenAddress,
    TOKEN_PROGRAM_ID,
    createAssociatedTokenAccountIdempotentInstruction,
    ASSOCIATED_TOKEN_PROGRAM_ID
} from "@solana/spl-token";
import BN from 'bn.js';

import {
    PUMP_FUN_PROGRAM_ID,
    FEE_RECIPIENT,
    GLOBAL,
    PUMP_FUN_ACCOUNT
} from '../../../utils/swaps/constants';

import { createHash } from 'crypto';
import { sendJitoTransaction, prepareJitoTip } from "../../../utils/fees/jito";
import { SettingsManager } from "../../../cli/utils/settingsManager";
import { BlockhashManager } from "../../../utils/swaps/blockhashManager";
import { PortfolioTracker } from "../../../utils/positions/portfolioTracker";
import { PumpSwapData } from "../../types/types";
import { CopyTradeSettingsManager } from "../../../cli/utils/copyTradingSettings";

// We add performance measurement from Node's perf_hooks
import { performance } from 'perf_hooks';

// --------------------------------------------------------------------
// Utility code for reading the bonding curve on-chain
// (Adapted from your pumpSwap.ts logic)
// --------------------------------------------------------------------
function deriveInstructionDiscriminator(nameSpace: string, ixName: string): Buffer {
    const hash = createHash('sha256')
        .update(`${nameSpace}:${ixName}`)
        .digest();
    return Buffer.from(hash.slice(0, 8));
}

const BUY_IX_DISCRIMINATOR = deriveInstructionDiscriminator('global', 'buy');
const SELL_IX_DISCRIMINATOR = deriveInstructionDiscriminator('global', 'sell');

async function handlePostTradePortfolioUpdate(
    connection: Connection,
    wallet: Keypair,
    signature: string,
    swapData: PumpSwapData,
    amountIn: number,
    userTokenAccount: PublicKey,
    isBuy: boolean
): Promise<void> {
    try {
        // Wait for transaction confirmation first
        const confirmation = await connection.confirmTransaction(signature);
        if (confirmation.value.err) {
            throw new Error('Transaction failed');
        }

        // Get token balance after confirmed swap
        const tokenAccount = await connection.getParsedTokenAccountsByOwner(
            wallet.publicKey,
            { mint: swapData.tokenAddress }
        );
        const currentBalance = tokenAccount.value[0]?.account.data.parsed.info.tokenAmount.uiAmount || 0;

        // Update portfolio tracker
        const portfolioTracker = PortfolioTracker.getInstance();
        
        if (isBuy) {
            await portfolioTracker.addPosition(
                swapData.tokenAddress.toString(),
                amountIn / LAMPORTS_PER_SOL,
                currentBalance,
                signature,
                {
                    isPumpToken: true
                }
            );
        } else {
            await portfolioTracker.addPosition(
                swapData.tokenAddress.toString(),
                -(amountIn / LAMPORTS_PER_SOL),
                -Math.abs(currentBalance),
                signature,
                {
                    isPumpToken: true
                }
            );
        }

    } catch (error) {
        console.error('Error updating portfolio after trade:', error);
    }
}

// Add build sell instruction function
async function buildPumpSellInstruction(
    wallet: PublicKey,
    tokenAccount: PublicKey,
    mint: PublicKey,
    coinData: any,
    amount: BN,
    minSolOutput: BN
): Promise<TransactionInstruction> {
    const data = Buffer.concat([
        SELL_IX_DISCRIMINATOR,
        amount.toArrayLike(Buffer, 'le', 8),
        minSolOutput.toArrayLike(Buffer, 'le', 8)
    ]);

    const keys = [
        { pubkey: GLOBAL, isSigner: false, isWritable: false },
        { pubkey: FEE_RECIPIENT, isSigner: false, isWritable: true },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: new PublicKey(coinData.bonding_curve), isSigner: false, isWritable: true },
        { pubkey: new PublicKey(coinData.associated_bonding_curve), isSigner: false, isWritable: true },
        { pubkey: tokenAccount, isSigner: false, isWritable: true },
        { pubkey: wallet, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: PUMP_FUN_ACCOUNT, isSigner: false, isWritable: false },
        { pubkey: PUMP_FUN_PROGRAM_ID, isSigner: false, isWritable: false }
    ];

    return new TransactionInstruction({
        programId: PUMP_FUN_PROGRAM_ID,
        keys,
        data
    });
}

// Add copy sell function
export async function copyPumpSellSwap(
    connection: Connection,
    wallet: Keypair,
    swapData: PumpSwapData,
    tokenAmount: number,
    slippageTolerance: number = 0.10
): Promise<string> {
    const overallStart = performance.now();
    console.log("\nInitiating pump.fun copy SELL...");

    try {
        // Step 1: Derive PDAs
        const step1Start = performance.now();
        const bondingCurvePk = deriveBondingCurvePda(swapData.tokenAddress);
        const associatedBondingCurvePk = await deriveAssociatedBondingCurvePda(swapData.tokenAddress);
        console.log(`Step 1 took ${(performance.now() - step1Start).toFixed(2)} ms`);

        // Step 2: Read bonding curve
        const step2Start = performance.now();
        const curveData = await readBondingCurveAccount(connection, bondingCurvePk);
        if (curveData.completed) {
            throw new Error("Token has migrated from pump.fun, can't sell.");
        }
        const coinData = {
            bonding_curve: bondingCurvePk.toBase58(),
            associated_bonding_curve: associatedBondingCurvePk.toBase58(),
            virtual_token_reserves: curveData.virtual_token_reserves,
            virtual_sol_reserves: curveData.virtual_sol_reserves,
            completed: curveData.completed
        };
        console.log(`Step 2 took ${(performance.now() - step2Start).toFixed(2)} ms`);

        // Step 3: Get user token account
        const step3Start = performance.now();
        const userTokenAccount = await getAssociatedTokenAddress(
            swapData.tokenAddress,
            wallet.publicKey
        );
        console.log(`Step 3 took ${(performance.now() - step3Start).toFixed(2)} ms`);

        // Step 4: Get blockhash and fees
        const step4Start = performance.now();
        const { blockhash, lastValidBlockHeight } = await BlockhashManager.getInstance().getBlockhash();
        
        const settings = SettingsManager.getInstance().getSettings();
        const DEFAULT_PRIORITY_FEE = 100_000;
        const priorityFeeEstimate = settings.fees.fixedPriorityFee || DEFAULT_PRIORITY_FEE;
        console.log(`Step 4 took ${(performance.now() - step4Start).toFixed(2)} ms`);

        // Step 5: Calculate expected output
        const step5Start = performance.now();
        const amountBN = new BN(tokenAmount.toString());
        const expectedOutput = calculateExpectedSolOutput(amountBN, coinData);
        const minSolOutput = expectedOutput.muln(Math.floor((1 - slippageTolerance) * 1000)).divn(1000);
        console.log(`Step 5 took ${(performance.now() - step5Start).toFixed(2)} ms`);

        // Step 6: Build transaction
        const step6Start = performance.now();
        const instructions: TransactionInstruction[] = [];

        // Compute units and priority fee
        const computeUnits = 200_000;
        instructions.push(
            ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnits }),
            ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFeeEstimate })
        );

        // Jito tip
        const jitoTip = await prepareJitoTip(priorityFeeEstimate, wallet.publicKey, false);
        instructions.push(jitoTip);

        // Sell instruction
        instructions.push(
            await buildPumpSellInstruction(
                wallet.publicKey,
                userTokenAccount,
                swapData.tokenAddress,
                coinData,
                amountBN,
                minSolOutput
            )
        );

        const messageV0 = new TransactionMessage({
            payerKey: wallet.publicKey,
            recentBlockhash: blockhash,
            instructions
        }).compileToV0Message();

        const transaction = new VersionedTransaction(messageV0);
        transaction.sign([wallet]);
        console.log(`Step 6 took ${(performance.now() - step6Start).toFixed(2)} ms`);

        // Step 7: Send and confirm
        const step7Start = performance.now();
        console.log('Sending transaction...');
        const signature = await sendJitoTransaction(transaction, { skipPreflight: true });

        await connection.confirmTransaction(
            {
                signature,
                blockhash,
                lastValidBlockHeight
            },
            "processed"
        );
        console.log(`Step 7 took ${(performance.now() - step7Start).toFixed(2)} ms`);

        // Update portfolio
        const postMetricsStart = performance.now();
        await handlePostTradePortfolioUpdate(
            connection,
            wallet,
            signature,
            swapData,
            tokenAmount,
            userTokenAccount,
            false
        );
        console.log(`Portfolio update took ${(performance.now() - postMetricsStart).toFixed(2)} ms`);

        console.log(`Overall function time: ${(performance.now() - overallStart).toFixed(2)} ms`);
        return signature;

    } catch (error) {
        console.error('\nTransaction failed:', error);
        throw error;
    }
}

// Calculate expected SOL output for sells
function calculateExpectedSolOutput(amountIn: BN, coinData: any): BN {
    const virtualTokenReserves = new BN(coinData.virtual_token_reserves);
    const virtualSolReserves = new BN(coinData.virtual_sol_reserves);
    
    const numerator = virtualSolReserves.mul(amountIn);
    const denominator = virtualTokenReserves.add(amountIn);
    
    return numerator.div(denominator);
}

function deriveBondingCurvePda(mint: PublicKey): PublicKey {
    const [pda] = PublicKey.findProgramAddressSync(
        [
            Buffer.from("bonding-curve"),
            mint.toBuffer()
        ],
        PUMP_FUN_PROGRAM_ID
    );
    return pda;
}

async function deriveAssociatedBondingCurvePda(mint: PublicKey): Promise<PublicKey> {
    const bondingCurve = deriveBondingCurvePda(mint);
    return await getAssociatedTokenAddress(mint, bondingCurve, true);
}

// Minimal interface for reading the curve data
interface BondingCurveData {
    virtual_token_reserves: string; // BN as string
    virtual_sol_reserves: string;   // BN as string
    real_token_reserves: string;
    real_sol_reserves: string;
    token_total_supply: string;
    completed: boolean;
}

async function readBondingCurveAccount(connection: Connection, bondingCurvePk: PublicKey): Promise<BondingCurveData> {
    const accountInfo = await connection.getAccountInfo(bondingCurvePk);
    if (!accountInfo) {
        throw new Error(`BondingCurve account not found: ${bondingCurvePk}`);
    }

    // Skip 8-byte discriminator
    let offset = 8;
    const data = accountInfo.data;

    return {
        virtual_token_reserves: new BN(data.slice(offset, offset + 8), 'le').toString(),
        virtual_sol_reserves: new BN(data.slice(offset + 8, offset + 16), 'le').toString(),
        real_token_reserves: new BN(data.slice(offset + 16, offset + 24), 'le').toString(),
        real_sol_reserves: new BN(data.slice(offset + 24, offset + 32), 'le').toString(),
        token_total_supply: new BN(data.slice(offset + 32, offset + 40), 'le').toString(),
        completed: data[offset + 40] !== 0
    };
}

// Simple pump.fun coin data structure
interface CoinData {
    bonding_curve: string;
    associated_bonding_curve: string;
    virtual_token_reserves: string;
    virtual_sol_reserves: string;
    completed: boolean;
}

function calculateExpectedOutput(
    amountInLamports: BN,
    coinData: CoinData
): BN {
    // For BUY: formula = (virtual_token_reserves * amountInLamports) / (virtual_sol_reserves + amountInLamports)
    const virtualTokenReserves = new BN(coinData.virtual_token_reserves);
    const virtualSolReserves = new BN(coinData.virtual_sol_reserves);
    const numerator = virtualTokenReserves.mul(amountInLamports);
    const denominator = virtualSolReserves.add(amountInLamports);
    return numerator.div(denominator);
}

// We build the actual Pump buy instruction using on-chain data:
async function buildPumpBuyInstruction(
    wallet: PublicKey,
    tokenAccount: PublicKey,
    mint: PublicKey,
    coinData: CoinData,
    expectedOutput: BN,
    maxSolCost: BN
): Promise<TransactionInstruction> {
    // Build the instruction data the same as your original approach
    const data = Buffer.concat([
        BUY_IX_DISCRIMINATOR,
        expectedOutput.toArrayLike(Buffer, 'le', 8),
        maxSolCost.toArrayLike(Buffer, 'le', 8)
    ]);

    const keys = [
        { pubkey: GLOBAL, isSigner: false, isWritable: false },
        { pubkey: FEE_RECIPIENT, isSigner: false, isWritable: true },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: new PublicKey(coinData.bonding_curve), isSigner: false, isWritable: true },
        { pubkey: new PublicKey(coinData.associated_bonding_curve), isSigner: false, isWritable: true },
        { pubkey: tokenAccount, isSigner: false, isWritable: true },
        { pubkey: wallet, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
        { pubkey: PUMP_FUN_ACCOUNT, isSigner: false, isWritable: false },
        { pubkey: PUMP_FUN_PROGRAM_ID, isSigner: false, isWritable: false }
    ];

    return new TransactionInstruction({
        programId: PUMP_FUN_PROGRAM_ID,
        keys,
        data
    });
}

// --------------------------------------------------------------------
// Main copy function
// --------------------------------------------------------------------
export async function copyPumpBuySwap(
    connection: Connection,
    wallet: Keypair,
    swapData: PumpSwapData,
    amountInLamports: number,
): Promise<string> {
    const settings = CopyTradeSettingsManager.getInstance().getSettings();
    const slippageTolerance = settings.slippageTolerance.pump / 100;
    const overallStart = performance.now();
    console.log("\nInitiating pump.fun copy BUY, using on-chain bonding curve...");

    console.log('Swap details from monitored tx:', {
        originalAmountIn: swapData.amountIn,
        originalAmountOut: swapData.amountOut,
        targetAmountIn: amountInLamports / LAMPORTS_PER_SOL
    });

    try {
        // Step 1: Derive PDAs
        const step1Start = performance.now();
        const bondingCurvePk = deriveBondingCurvePda(swapData.tokenAddress);
        const associatedBondingCurvePk = await deriveAssociatedBondingCurvePda(swapData.tokenAddress);
        console.log('Bonding curve PDAs:', {
            bondingCurvePk: bondingCurvePk.toBase58(),
            associatedBondingCurvePk: associatedBondingCurvePk.toBase58()
        });
        console.log(`Step 1 took ${(performance.now() - step1Start).toFixed(2)} ms`);

        // Step 2: Read the on-chain bonding curve
        const step2Start = performance.now();
        const curveData = await readBondingCurveAccount(connection, bondingCurvePk);
        if (curveData.completed) {
            throw new Error("Token has migrated from pump.fun, can't buy.");
        }
        const coinData: CoinData = {
            bonding_curve: bondingCurvePk.toBase58(),
            associated_bonding_curve: associatedBondingCurvePk.toBase58(),
            virtual_token_reserves: curveData.virtual_token_reserves,
            virtual_sol_reserves: curveData.virtual_sol_reserves,
            completed: curveData.completed
        };
        console.log(`Step 2 took ${(performance.now() - step2Start).toFixed(2)} ms`);

        // Step 3: Prepare user token account
        const step3Start = performance.now();
        const userTokenAccount = await getAssociatedTokenAddress(
            swapData.tokenAddress,
            wallet.publicKey
        );
        console.log('User token account:', userTokenAccount.toString());
        console.log(`Step 3 took ${(performance.now() - step3Start).toFixed(2)} ms`);

        // Step 4: Retrieve blockhash and fees
        const step4Start = performance.now();
        const { blockhash, lastValidBlockHeight } = await BlockhashManager.getInstance().getBlockhash();
        console.log('Using blockhash:', blockhash);

        const settings = SettingsManager.getInstance().getSettings();
        const DEFAULT_PRIORITY_FEE = 100_000; // remain consistent with your older approach
        const priorityFeeEstimate = settings.fees.fixedPriorityFee || DEFAULT_PRIORITY_FEE;
        console.log('Priority fee (microLamports/compute-unit):', priorityFeeEstimate);
        console.log(`Step 4 took ${(performance.now() - step4Start).toFixed(2)} ms`);

        // Step 5: Calculate expected output and maxSolCost from on-chain reserves
        const step5Start = performance.now();
        const ourSolAmountBN = new BN(amountInLamports.toString());
        const expectedOutputBN = calculateExpectedOutput(ourSolAmountBN, coinData);
        const maxSolCostBN = ourSolAmountBN.muln(Math.floor((1 + slippageTolerance) * 1000)).divn(1000);

        console.log('Swap math:', {
            amountInLamports,
            amountInSOL: amountInLamports / LAMPORTS_PER_SOL,
            expectedOutputBN: expectedOutputBN.toString(),
            maxSolCostBN: maxSolCostBN.toString(),
            slippageTolerance
        });
        console.log(`Step 5 took ${(performance.now() - step5Start).toFixed(2)} ms`);

        // Step 6: Build transaction instructions
        const step6Start = performance.now();
        const transactionInstructions: TransactionInstruction[] = [];

        // Instead of checking if the account exists, we create or verify ATA idempotently:
        console.log('Creating or verifying associated token account (idempotent)...');
        transactionInstructions.push(
            createAssociatedTokenAccountIdempotentInstruction(
                wallet.publicKey,
                userTokenAccount,
                wallet.publicKey,
                swapData.tokenAddress
            )
        );

        // Pump.fun BUY
        transactionInstructions.push(
            await buildPumpBuyInstruction(
                wallet.publicKey,
                userTokenAccount,
                swapData.tokenAddress,
                coinData,
                expectedOutputBN,
                maxSolCostBN
            )
        );
        console.log(`Step 6 took ${(performance.now() - step6Start).toFixed(2)} ms`);

        // Step 7: Build and sign transaction
        const step7Start = performance.now();
        // Potentially increase compute units
        const computeUnits = Math.min(200_000 * transactionInstructions.length, 1_400_000);
        console.log(`Compute units for transaction: ${computeUnits}`);

        // Priority fee logic
        const instructions: TransactionInstruction[] = [
            ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnits }),
            ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFeeEstimate })
        ];

        // Jito tip
        const jitoTip = await prepareJitoTip(priorityFeeEstimate, wallet.publicKey, false);
        instructions.push(jitoTip);

        // Add our main transaction instructions
        instructions.push(...transactionInstructions);

        // Build and sign transaction
        const messageV0 = new TransactionMessage({
            payerKey: wallet.publicKey,
            recentBlockhash: blockhash,
            instructions
        }).compileToV0Message();
        const transaction = new VersionedTransaction(messageV0);
        transaction.sign([wallet]);
        console.log(`Step 7 took ${(performance.now() - step7Start).toFixed(2)} ms`);

        // Step 8: Send transaction (simulation removed as requested)
        const step8Start = performance.now();
        console.log('Sending transaction...');
        const signature = await sendJitoTransaction(transaction, { skipPreflight: true });
        console.log(`Transaction sent: ${signature}`);
        console.log('Awaiting confirmation...');

        await connection.confirmTransaction(
            {
                signature,
                blockhash,
                lastValidBlockHeight
            },
            "processed"
        );
        console.log('\nTransaction successful!');
        console.log(`Explorer link: https://solscan.io/tx/${signature}`);
        console.log(`Step 8 took ${(performance.now() - step8Start).toFixed(2)} ms`);

        // Optional post-swap metrics
        const postMetricsStart = performance.now();
        try {
            const postTokenAccount = await connection.getParsedTokenAccountsByOwner(
                wallet.publicKey,
                { mint: swapData.tokenAddress }
            );
            if (postTokenAccount.value[0]?.account.data.parsed.info.tokenAmount) {
                console.log('Post-swap token balance:', {
                    amount: postTokenAccount.value[0].account.data.parsed.info.tokenAmount.uiAmount,
                    decimals: postTokenAccount.value[0].account.data.parsed.info.tokenAmount.decimals
                });
            }
        } catch (err) {
            console.log('Failed to fetch token info after swap:', err);
        }
        console.log(`Fetching post-swap metrics took ${(performance.now() - postMetricsStart).toFixed(2)} ms`);

        console.log(`Overall function time: ${(performance.now() - overallStart).toFixed(2)} ms`);
        return signature;

    } catch (error) {
        console.error('\nTransaction failed:', error);
        if (error instanceof Error) {
            console.error('Error details:', error.stack);
        }
        throw error;
    }
}

/*
SUGGESTIONS FOR SPEED IMPROVEMENTS:
1. Reuse Blockhashes: If sending multiple transactions in quick succession, 
   you can fetch a blockhash once and reuse it for multiple transactions (within validity windows).
2. Batch or pipeline instructions: If you have many instructions, combine them into as few 
   transactions as possible to reduce overhead.
3. Use skipPreflight: Already done here. This saves time but trades off some safety checks.
4. Avoid extra round trips: Minimizing calls like getAccountInfo or getParsedTokenAccountsByOwner 
   can speed up your application if you can cache or remember states from previous queries.
5. Consider smaller compute unit price if adequate: This can save costs, 
   but might trade off priority on busy networks.
*/
