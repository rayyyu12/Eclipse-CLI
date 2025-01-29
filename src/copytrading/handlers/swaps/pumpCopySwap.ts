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
import chalk from "chalk";
import { COLORS } from "../../../cli/config";

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
const DEFAULT_PRIORITY_FEE = 100_000;

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
        const confirmation = await connection.confirmTransaction(signature);
        if (confirmation.value.err) {
            throw new Error('Transaction failed');
        }

        const tokenAccount = await connection.getParsedTokenAccountsByOwner(
            wallet.publicKey,
            { mint: swapData.tokenAddress }
        );
        const currentBalance = tokenAccount.value[0]?.account.data.parsed.info.tokenAmount.uiAmount || 0;

        const portfolioTracker = PortfolioTracker.getInstance();
        
        if (isBuy) {
            await portfolioTracker.addPosition(
                swapData.tokenAddress.toString(),
                amountIn / LAMPORTS_PER_SOL,
                currentBalance,
                signature,
                { isPumpToken: true }
            );
        } else {
            await portfolioTracker.addPosition(
                swapData.tokenAddress.toString(),
                -(amountIn / LAMPORTS_PER_SOL),
                -Math.abs(currentBalance),
                signature,
                { isPumpToken: true }
            );
        }

        console.log(chalk.hex(COLORS.SUCCESS)('\nPortfolio update successful:'));
        console.log(`Token: ${swapData.tokenAddress.toString()}`);
        console.log(`Balance: ${currentBalance.toFixed(6)}`);

    } catch (error) {
        console.error(chalk.hex(COLORS.ERROR)('Portfolio update failed:'), error);
    }
}

// Add build sell instruction function
async function buildPumpSellInstruction(
    wallet: PublicKey,
    tokenAccount: PublicKey,
    mint: PublicKey,
    coinData: CoinData,
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

    return new TransactionInstruction({ programId: PUMP_FUN_PROGRAM_ID, keys, data });
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
    console.log(chalk.hex(COLORS.PRIMARY)('\nInitiating pump.fun sell...'));

    try {
        // Step 1: Derive PDAs
        const bondingCurvePk = deriveBondingCurvePda(swapData.tokenAddress);
        const associatedBondingCurvePk = await deriveAssociatedBondingCurvePda(swapData.tokenAddress);

        // Step 2: Read bonding curve
        const curveData = await readBondingCurveAccount(connection, bondingCurvePk);
        if (curveData.completed) {
            throw new Error("Token has migrated from pump.fun");
        }

        const coinData = {
            bonding_curve: bondingCurvePk.toBase58(),
            associated_bonding_curve: associatedBondingCurvePk.toBase58(),
            virtual_token_reserves: curveData.virtual_token_reserves,
            virtual_sol_reserves: curveData.virtual_sol_reserves,
            completed: curveData.completed
        };

        // Step 3: Get user token account
        const userTokenAccount = await getAssociatedTokenAddress(
            swapData.tokenAddress,
            wallet.publicKey
        );

        // Step 4: Get blockhash and fees
        const { blockhash, lastValidBlockHeight } = await BlockhashManager.getInstance().getBlockhash();
        const settings = SettingsManager.getInstance().getSettings();
        const priorityFeeEstimate = settings.fees.fixedPriorityFee || DEFAULT_PRIORITY_FEE;

        // Step 5: Calculate expected output
        const amountBN = new BN(tokenAmount.toString());
        const expectedOutput = calculateExpectedSolOutput(amountBN, coinData);
        const minSolOutput = expectedOutput.muln(Math.floor((1 - slippageTolerance) * 1000)).divn(1000);

        console.log(chalk.hex(COLORS.PRIMARY)('\nSell Parameters:'));
        console.log(`Amount In: ${tokenAmount} Tokens`);
        console.log(`Expected Output: ${(expectedOutput.toNumber() / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
        console.log(`Min Output: ${(minSolOutput.toNumber() / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
        console.log(`Slippage: ${(slippageTolerance * 100).toFixed(2)}%`);

        // Step 6: Build instructions
        const instructions = [
            ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
            ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFeeEstimate }),
            await prepareJitoTip(priorityFeeEstimate, wallet.publicKey, false),
            await buildPumpSellInstruction(
                wallet.publicKey,
                userTokenAccount,
                swapData.tokenAddress,
                coinData,
                amountBN,
                minSolOutput
            )
        ];

        // Step 7: Build and send transaction
        const messageV0 = new TransactionMessage({
            payerKey: wallet.publicKey,
            recentBlockhash: blockhash,
            instructions
        }).compileToV0Message();

        const transaction = new VersionedTransaction(messageV0);
        transaction.sign([wallet]);

        console.log(chalk.hex(COLORS.PRIMARY)('\nSending transaction...'));
        const signature = await sendJitoTransaction(transaction, { skipPreflight: true });

        console.log(chalk.hex(COLORS.PRIMARY)('Awaiting confirmation...'));
        await connection.confirmTransaction({
            signature,
            blockhash,
            lastValidBlockHeight
        }, "processed");

        console.log(chalk.hex(COLORS.SUCCESS)('\nTransaction successful!'));
        console.log(`Signature: ${chalk.hex(COLORS.ACCENT)(signature)}`);
        console.log(`Explorer: ${chalk.hex(COLORS.ACCENT)(`https://solscan.io/tx/${signature}`)}`);

        // Update portfolio
        await handlePostTradePortfolioUpdate(
            connection,
            wallet,
            signature,
            swapData,
            tokenAmount,
            userTokenAccount,
            false
        );

        console.log(chalk.hex(COLORS.PRIMARY)(`\nTotal execution time: ${(performance.now() - overallStart).toFixed(2)}ms`));
        return signature;

    } catch (error) {
        console.error(chalk.hex(COLORS.ERROR)('\nTransaction failed:'), error);
        throw error;
    }
}

// Calculate expected SOL output for sells
function calculateExpectedSolOutput(amountIn: BN, coinData: CoinData): BN {
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

function calculateExpectedOutput(amountInLamports: BN, coinData: CoinData): BN {
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

    return new TransactionInstruction({ programId: PUMP_FUN_PROGRAM_ID, keys, data });
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
    
    console.log(chalk.hex(COLORS.PRIMARY)('\nInitiating pump.fun buy...'));

    try {
        // Step 1: Derive PDAs
        const bondingCurvePk = deriveBondingCurvePda(swapData.tokenAddress);
        const associatedBondingCurvePk = await deriveAssociatedBondingCurvePda(swapData.tokenAddress);

        // Step 2: Read bonding curve
        const curveData = await readBondingCurveAccount(connection, bondingCurvePk);
        if (curveData.completed) {
            throw new Error("Token has migrated from pump.fun");
        }

        const coinData: CoinData = {
            bonding_curve: bondingCurvePk.toBase58(),
            associated_bonding_curve: associatedBondingCurvePk.toBase58(),
            virtual_token_reserves: curveData.virtual_token_reserves,
            virtual_sol_reserves: curveData.virtual_sol_reserves,
            completed: curveData.completed
        };

        // Step 3: Get user token account
        const userTokenAccount = await getAssociatedTokenAddress(
            swapData.tokenAddress,
            wallet.publicKey
        );

        // Step 4: Get blockhash and fees
        const { blockhash, lastValidBlockHeight } = await BlockhashManager.getInstance().getBlockhash();
        const settings = SettingsManager.getInstance().getSettings();
        const priorityFeeEstimate = settings.fees.fixedPriorityFee || DEFAULT_PRIORITY_FEE;

        // Step 5: Calculate expected output
        const ourSolAmountBN = new BN(amountInLamports.toString());
        const expectedOutputBN = calculateExpectedOutput(ourSolAmountBN, coinData);
        const maxSolCostBN = ourSolAmountBN.muln(Math.floor((1 + slippageTolerance) * 1000)).divn(1000);

        console.log(chalk.hex(COLORS.PRIMARY)('\nSwap Parameters:'));
        console.log(`Amount In: ${(amountInLamports / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
        console.log(`Expected Output: ${expectedOutputBN.toString()}`);
        console.log(`Max Cost: ${(maxSolCostBN.toNumber() / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
        console.log(`Slippage: ${(slippageTolerance * 100).toFixed(2)}%`);

        // Step 6: Build instructions
        const instructions = [
            ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
            ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFeeEstimate }),
            await prepareJitoTip(priorityFeeEstimate, wallet.publicKey, false),
            createAssociatedTokenAccountIdempotentInstruction(
                wallet.publicKey,
                userTokenAccount,
                wallet.publicKey,
                swapData.tokenAddress
            ),
            await buildPumpBuyInstruction(
                wallet.publicKey,
                userTokenAccount,
                swapData.tokenAddress,
                coinData,
                expectedOutputBN,
                maxSolCostBN
            )
        ];

        // Step 7: Build and send transaction
        const messageV0 = new TransactionMessage({
            payerKey: wallet.publicKey,
            recentBlockhash: blockhash,
            instructions
        }).compileToV0Message();

        const transaction = new VersionedTransaction(messageV0);
        transaction.sign([wallet]);

        console.log(chalk.hex(COLORS.PRIMARY)('\nSending transaction...'));
        const signature = await sendJitoTransaction(transaction, { skipPreflight: true });

        console.log(chalk.hex(COLORS.PRIMARY)('Awaiting confirmation...'));
        await connection.confirmTransaction({
            signature,
            blockhash,
            lastValidBlockHeight
        }, "processed");

        console.log(chalk.hex(COLORS.SUCCESS)('\nTransaction successful!'));
        console.log(`Signature: ${chalk.hex(COLORS.ACCENT)(signature)}`);
        console.log(`Explorer: ${chalk.hex(COLORS.ACCENT)(`https://solscan.io/tx/${signature}`)}`);

        // Update portfolio
        await handlePostTradePortfolioUpdate(
            connection,
            wallet,
            signature,
            swapData,
            amountInLamports,
            userTokenAccount,
            true
        );

        console.log(chalk.hex(COLORS.PRIMARY)(`\nTotal execution time: ${(performance.now() - overallStart).toFixed(2)}ms`));
        return signature;

    } catch (error) {
        console.error(chalk.hex(COLORS.ERROR)('\nTransaction failed:'), error);
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
