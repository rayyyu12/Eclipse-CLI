//raydiumCopySwap.ts
import {
    Connection,
    Keypair,
    TransactionMessage,
    VersionedTransaction,
    ComputeBudgetProgram,
    PublicKey,
    SystemProgram,
    LAMPORTS_PER_SOL,
    ParsedAccountData
} from "@solana/web3.js";
import { SettingsManager } from "../../../cli/utils/settingsManager";
import {
    getAssociatedTokenAddress,
    createAssociatedTokenAccountIdempotentInstruction,
    createSyncNativeInstruction,
    NATIVE_MINT,
    createCloseAccountInstruction,
    getAccount as getTokenAccount
} from "@solana/spl-token";
import { RaydiumSwapData } from "../../types/types";
import { buildSwapInstruction } from "../../../utils/swaps/swapBuilder";
import { sendJitoTransaction, prepareJitoTip } from "../../../utils/fees/jito";
import BN from "bn.js";
import { BlockhashManager } from "../../../utils/swaps/blockhashManager";
import { PortfolioTracker } from "../../../utils/positions/portfolioTracker";

const DEFAULT_PRIORITY_FEE = 100_000;
const POOL_FEE_BUFFER = 0.003; // 0.3%

async function handlePostTradePortfolioUpdate(
    connection: Connection,
    wallet: Keypair,
    signature: string,
    swapData: RaydiumSwapData,
    amountIn: number,
    userOutAddress: PublicKey,
    tokenDecimals: number
): Promise<void> {
    try {
        if (!swapData.isBuy) return; // Only handle buy trades

        // Get token balance after swap
        const accountInfo = await getTokenAccount(connection, userOutAddress);
        const tokenBalance = Number(accountInfo.amount) / Math.pow(10, tokenDecimals);

        // Calculate entry price
        const entryPrice = amountIn / LAMPORTS_PER_SOL / tokenBalance;

        // Add position to portfolio tracker
        const portfolioTracker = PortfolioTracker.getInstance();
        
        // Add the position first
        await portfolioTracker.addPosition(
            swapData.tokenAddress.toString(),
            amountIn / LAMPORTS_PER_SOL,
            tokenBalance,
            signature,
            {
                entryPriceOverride: entryPrice,
                isPumpToken: false
            }
        );

        console.log('Portfolio position added successfully:', {
            tokenAddress: swapData.tokenAddress.toString(),
            tokenBalance,
            entryPrice
        });

    } catch (error) {
        console.error('Error updating portfolio after trade:', error);
        // Don't throw - we don't want to affect the main flow
    }
}

function calculateSwapOutput(
    amountIn: number,
    poolBalances: {
        coin: { pre: number, post: number, decimals: number },
        pc: { pre: number, post: number, decimals: number }
    },
    tokenDecimals: number
): { expectedOutput: number, rawCalculation: string } {
    const rawPoolCoin = poolBalances.coin.pre;
    const rawPoolPc = poolBalances.pc.pre;
    
    const decimalAdjustment = Math.pow(10, 9 - tokenDecimals);
    const rawExpectedOutput = (amountIn * rawPoolPc) / (rawPoolCoin * decimalAdjustment);
    const expectedOutput = Math.floor(rawExpectedOutput * Math.pow(10, -4));

    return {
        expectedOutput,
        rawCalculation: `(${amountIn} * ${rawPoolPc}) / (${rawPoolCoin} * ${decimalAdjustment}) * 1e-4 = ${expectedOutput}`
    };
}

export async function copyRaydiumSwap(
    connection: Connection,
    wallet: Keypair,
    swapData: RaydiumSwapData,
    amountIn: number,
    slippageTolerance: number = 0.5
): Promise<string> {
    console.log("\nInitiating copy trade...");

    if (!swapData.poolBalances?.coin || !swapData.poolBalances?.pc) {
        throw new Error("Missing pool balance information");
    }

    // Token decimal handling
    const tokenDecimals = swapData.isBuy ? 9 : 6;
    
    // Get cached blockhash
    const { blockhash, lastValidBlockHeight } = await BlockhashManager.getInstance().getBlockhash();

    // ATA computation
    const userInMint = new PublicKey(swapData.tokenInMint!);
    const userOutMint = new PublicKey(swapData.tokenOutMint!);
    const [userWSOLAddress, userInAddress, userOutAddress] = await Promise.all([
        getAssociatedTokenAddress(NATIVE_MINT, wallet.publicKey, false),
        getAssociatedTokenAddress(userInMint, wallet.publicKey, false),
        getAssociatedTokenAddress(userOutMint, wallet.publicKey, false)
    ]);

    // Handle priority fee
    const settings = SettingsManager.getInstance().getSettings();
    const priorityFeeEstimate = settings.fees.fixedPriorityFee || DEFAULT_PRIORITY_FEE;

    // Build instructions array
    const instructions = [];

    // Compute budget
    const computeUnits = 200_000;
    instructions.push(
        ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnits }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFeeEstimate })
    );

    // Jito tip
    const jitoTip = await prepareJitoTip(priorityFeeEstimate, wallet.publicKey, false);
    instructions.push(jitoTip);

    // ATA creation
    instructions.push(
        createAssociatedTokenAccountIdempotentInstruction(
            wallet.publicKey,
            userInAddress,
            wallet.publicKey,
            userInMint
        ),
        createAssociatedTokenAccountIdempotentInstruction(
            wallet.publicKey,
            userOutAddress,
            wallet.publicKey,
            userOutMint
        ),
        createAssociatedTokenAccountIdempotentInstruction(
            wallet.publicKey,
            userWSOLAddress,
            wallet.publicKey,
            NATIVE_MINT
        )
    );

    // SOL wrapping for buys
    if (swapData.isBuy) {
        instructions.push(
            SystemProgram.transfer({
                fromPubkey: wallet.publicKey,
                toPubkey: userWSOLAddress,
                lamports: amountIn
            }),
            createSyncNativeInstruction(userWSOLAddress)
        );
    }

    // Calculate swap amounts
    const swapCalcResult = calculateSwapOutput(
        amountIn,
        swapData.poolBalances,
        tokenDecimals
    );

    const expectedOutput = swapCalcResult.expectedOutput;
    const minAmountOut = Math.floor(expectedOutput * (1 - slippageTolerance - POOL_FEE_BUFFER));

    // Create BNs for swap
    const amountInBN = new BN(amountIn.toString());
    const minAmountOutBN = new BN(minAmountOut.toString());

    // Set up swap accounts
    const userInputAccount = swapData.isBuy ? userWSOLAddress : userInAddress;
    const userOutputAccount = swapData.isBuy ? userOutAddress : userWSOLAddress;

    // Build swap instruction
    const swapInstruction = await buildSwapInstruction(
        wallet.publicKey,
        userInputAccount,
        userOutputAccount,
        {
            ammId: swapData.ammId,
            ammAuthority: swapData.ammAuthority,
            ammOpenOrders: swapData.ammOpenOrders,
            ammTargetOrders: swapData.ammTargetOrders,
            poolCoinTokenAccount: swapData.poolCoinTokenAccount,
            poolPcTokenAccount: swapData.poolPcTokenAccount,
            serumProgramId: swapData.serumProgramId,
            serumMarket: swapData.serumMarket,
            serumBids: swapData.serumBids,
            serumAsks: swapData.serumAsks,
            serumEventQueue: swapData.serumEventQueue,
            serumCoinVaultAccount: swapData.serumBaseVault,
            serumPcVaultAccount: swapData.serumQuoteVault,
            serumVaultSigner: swapData.serumOpenOrders
        },
        amountInBN,
        minAmountOutBN,
        true
    );
    instructions.push(swapInstruction);

    // WSOL cleanup for sells
    if (!swapData.isBuy) {
        instructions.push(
            createCloseAccountInstruction(userWSOLAddress, wallet.publicKey, wallet.publicKey)
        );
    }

    // Build and send transaction
    const messageV0 = new TransactionMessage({
        payerKey: wallet.publicKey,
        recentBlockhash: blockhash,
        instructions
    }).compileToV0Message();

    const transaction = new VersionedTransaction(messageV0);
    transaction.sign([wallet]);

    try {
        console.log('\nSending transaction...');
        const signature = await sendJitoTransaction(transaction, { 
            skipPreflight: true 
        });

        console.log(`Transaction sent: ${signature}`);
        
        // Wait for confirmation
        console.log('Awaiting confirmation...');
        await connection.confirmTransaction({
            signature,
            blockhash,
            lastValidBlockHeight
        });

        // Get transaction result
        const confirmedTx = await connection.getTransaction(signature, {
            maxSupportedTransactionVersion: 0
        });

        if (confirmedTx?.meta?.err) {
            throw new Error(`Transaction failed: ${JSON.stringify(confirmedTx.meta.err)}`);
        }

        console.log('\nTransaction successful!');
        console.log(`Explorer link: https://solscan.io/tx/${signature}`);

        // Handle portfolio tracking after successful confirmation
        if (swapData.isBuy) {
            await handlePostTradePortfolioUpdate(
                connection,
                wallet,
                signature,
                swapData,
                amountIn,
                userOutputAccount,
                tokenDecimals
            ).catch(error => {
                console.error('Portfolio tracking error:', error);
                // Don't throw - we don't want to affect the main flow
            });
        }

        return signature;
    } catch (error) {
        console.error('\nTransaction failed:', error);
        if (error instanceof Error) {
            console.error('Error details:', error.stack);
        }
        throw error;
    }
}