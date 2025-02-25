//raydiumCopySwap.ts
import {
    Connection,
    Keypair,
    TransactionMessage,
    VersionedTransaction,
    ComputeBudgetProgram,
    PublicKey,
    SystemProgram,
    LAMPORTS_PER_SOL
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
import { CopyTradeSettingsManager } from "../../../cli/utils/copyTradingSettings";
import chalk from 'chalk';
import { COLORS } from '../../../cli/config';

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
        if (!swapData.isBuy) return;

        const accountInfo = await getTokenAccount(connection, userOutAddress);
        const tokenBalance = Number(accountInfo.amount) / Math.pow(10, tokenDecimals);
        const entryPrice = amountIn / LAMPORTS_PER_SOL / tokenBalance;

        const portfolioTracker = PortfolioTracker.getInstance();
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

        console.log(chalk.hex(COLORS.SUCCESS)('\nPortfolio Updated:'));
        console.log(`Token: ${swapData.tokenAddress.toString()}`);
        console.log(`Balance: ${tokenBalance.toFixed(6)}`);
        console.log(`Entry Price: ${entryPrice.toExponential(6)} SOL`);

    } catch (error) {
        console.error(chalk.hex(COLORS.ERROR)('Error updating portfolio:'), error);
    }
}

function calculateSwapOutput(
    amountIn: number,
    poolBalances: {
        coin: { pre: number, post: number, decimals: number },
        pc: { pre: number, post: number, decimals: number }
    },
    tokenDecimals: number
): { expectedOutput: number } {
    const rawPoolCoin = poolBalances.coin.pre;
    const rawPoolPc = poolBalances.pc.pre;
    
    const decimalAdjustment = Math.pow(10, 9 - tokenDecimals);
    const rawExpectedOutput = (amountIn * rawPoolPc) / (rawPoolCoin * decimalAdjustment);
    return {
        expectedOutput: Math.floor(rawExpectedOutput * Math.pow(10, -4))
    };
}

export async function copyRaydiumSwap(
    connection: Connection,
    wallet: Keypair,
    swapData: RaydiumSwapData,
    amountIn: number,
): Promise<string> {
    console.log(chalk.hex(COLORS.PRIMARY)('\nInitiating Raydium swap...'));
    
    try {
        const copyTradeSettings = CopyTradeSettingsManager.getInstance().getSettings();
        const generalSettings = SettingsManager.getInstance().getSettings();
        const slippageTolerance = copyTradeSettings.slippageTolerance.raydium / 100;

        if (!swapData.poolBalances?.coin || !swapData.poolBalances?.pc) {
            throw new Error("Missing pool balance information");
        }

        const tokenDecimals = swapData.isBuy ? 9 : 6;
        const { blockhash, lastValidBlockHeight } = await BlockhashManager.getInstance().getBlockhash();

        // Get ATAs
        const userInMint = new PublicKey(swapData.tokenInMint!);
        const userOutMint = new PublicKey(swapData.tokenOutMint!);
        const [userWSOLAddress, userInAddress, userOutAddress] = await Promise.all([
            getAssociatedTokenAddress(NATIVE_MINT, wallet.publicKey, false),
            getAssociatedTokenAddress(userInMint, wallet.publicKey, false),
            getAssociatedTokenAddress(userOutMint, wallet.publicKey, false)
        ]);

        const priorityFeeEstimate = generalSettings.fees.fixedPriorityFee || DEFAULT_PRIORITY_FEE;
        const instructions = [];

        // Add compute budget instructions
        instructions.push(
            ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
            ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFeeEstimate })
        );

        // Add Jito tip
        instructions.push(await prepareJitoTip(priorityFeeEstimate, wallet.publicKey, false));

        // Create ATAs
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

        // Handle SOL wrapping for buys
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
        const { expectedOutput } = calculateSwapOutput(amountIn, swapData.poolBalances, tokenDecimals);
        const minAmountOut = Math.floor(expectedOutput * (1 - slippageTolerance - POOL_FEE_BUFFER));

        console.log(chalk.hex(COLORS.PRIMARY)('\nSwap Parameters:'));
        console.log(`Input Amount: ${amountIn / LAMPORTS_PER_SOL} SOL`);
        console.log(`Expected Output: ${expectedOutput}`);
        console.log(`Minimum Output: ${minAmountOut}`);
        console.log(`Slippage: ${slippageTolerance * 100}%`);

        const amountInBN = new BN(amountIn.toString());
        const minAmountOutBN = new BN(minAmountOut.toString());

        const userInputAccount = swapData.isBuy ? userWSOLAddress : userInAddress;
        const userOutputAccount = swapData.isBuy ? userOutAddress : userWSOLAddress;

        // Build and add swap instruction
        instructions.push(
            await buildSwapInstruction(
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
            )
        );

        // Add WSOL cleanup for sells
        if (!swapData.isBuy) {
            instructions.push(
                createCloseAccountInstruction(userWSOLAddress, wallet.publicKey, wallet.publicKey)
            );
        }

        // Build and sign transaction
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
        });

        const confirmedTx = await connection.getTransaction(signature, {
            maxSupportedTransactionVersion: 0
        });

        if (confirmedTx?.meta?.err) {
            throw new Error(`Transaction failed: ${JSON.stringify(confirmedTx.meta.err)}`);
        }

        console.log(chalk.hex(COLORS.SUCCESS)('\nTransaction successful!'));
        console.log(`Signature: ${chalk.hex(COLORS.ACCENT)(signature)}`);
        console.log(`Explorer: ${chalk.hex(COLORS.ACCENT)(`https://solscan.io/tx/${signature}`)}`);

        if (swapData.isBuy) {
            await handlePostTradePortfolioUpdate(
                connection,
                wallet,
                signature,
                swapData,
                amountIn,
                userOutputAccount,
                tokenDecimals
            );
        }

        return signature;

    } catch (error) {
        console.error(chalk.hex(COLORS.ERROR)('\nSwap failed:'), error);
        throw error;
    }
}