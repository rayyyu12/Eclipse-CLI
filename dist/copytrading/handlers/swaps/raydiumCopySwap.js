"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.copyRaydiumSwap = copyRaydiumSwap;
//raydiumCopySwap.ts
const web3_js_1 = require("@solana/web3.js");
const settingsManager_1 = require("../../../cli/utils/settingsManager");
const spl_token_1 = require("@solana/spl-token");
const swapBuilder_1 = require("../../../utils/swaps/swapBuilder");
const jito_1 = require("../../../utils/fees/jito");
const bn_js_1 = __importDefault(require("bn.js"));
const blockhashManager_1 = require("../../../utils/swaps/blockhashManager");
const portfolioTracker_1 = require("../../../utils/positions/portfolioTracker");
const copyTradingSettings_1 = require("../../../cli/utils/copyTradingSettings");
const chalk_1 = __importDefault(require("chalk"));
const config_1 = require("../../../cli/config");
const DEFAULT_PRIORITY_FEE = 100000;
const POOL_FEE_BUFFER = 0.003; // 0.3%
async function handlePostTradePortfolioUpdate(connection, wallet, signature, swapData, amountIn, userOutAddress, tokenDecimals) {
    try {
        if (!swapData.isBuy)
            return;
        const accountInfo = await (0, spl_token_1.getAccount)(connection, userOutAddress);
        const tokenBalance = Number(accountInfo.amount) / Math.pow(10, tokenDecimals);
        const entryPrice = amountIn / web3_js_1.LAMPORTS_PER_SOL / tokenBalance;
        const portfolioTracker = portfolioTracker_1.PortfolioTracker.getInstance();
        await portfolioTracker.addPosition(swapData.tokenAddress.toString(), amountIn / web3_js_1.LAMPORTS_PER_SOL, tokenBalance, signature, {
            entryPriceOverride: entryPrice,
            isPumpToken: false
        });
        console.log(chalk_1.default.hex(config_1.COLORS.SUCCESS)('\nPortfolio Updated:'));
        console.log(`Token: ${swapData.tokenAddress.toString()}`);
        console.log(`Balance: ${tokenBalance.toFixed(6)}`);
        console.log(`Entry Price: ${entryPrice.toExponential(6)} SOL`);
    }
    catch (error) {
        console.error(chalk_1.default.hex(config_1.COLORS.ERROR)('Error updating portfolio:'), error);
    }
}
function calculateSwapOutput(amountIn, poolBalances, tokenDecimals) {
    const rawPoolCoin = poolBalances.coin.pre;
    const rawPoolPc = poolBalances.pc.pre;
    const decimalAdjustment = Math.pow(10, 9 - tokenDecimals);
    const rawExpectedOutput = (amountIn * rawPoolPc) / (rawPoolCoin * decimalAdjustment);
    return {
        expectedOutput: Math.floor(rawExpectedOutput * Math.pow(10, -4))
    };
}
async function copyRaydiumSwap(connection, wallet, swapData, amountIn) {
    console.log(chalk_1.default.hex(config_1.COLORS.PRIMARY)('\nInitiating Raydium swap...'));
    try {
        const copyTradeSettings = copyTradingSettings_1.CopyTradeSettingsManager.getInstance().getSettings();
        const generalSettings = settingsManager_1.SettingsManager.getInstance().getSettings();
        const slippageTolerance = copyTradeSettings.slippageTolerance.raydium / 100;
        if (!swapData.poolBalances?.coin || !swapData.poolBalances?.pc) {
            throw new Error("Missing pool balance information");
        }
        const tokenDecimals = swapData.isBuy ? 9 : 6;
        const { blockhash, lastValidBlockHeight } = await blockhashManager_1.BlockhashManager.getInstance().getBlockhash();
        // Get ATAs
        const userInMint = new web3_js_1.PublicKey(swapData.tokenInMint);
        const userOutMint = new web3_js_1.PublicKey(swapData.tokenOutMint);
        const [userWSOLAddress, userInAddress, userOutAddress] = await Promise.all([
            (0, spl_token_1.getAssociatedTokenAddress)(spl_token_1.NATIVE_MINT, wallet.publicKey, false),
            (0, spl_token_1.getAssociatedTokenAddress)(userInMint, wallet.publicKey, false),
            (0, spl_token_1.getAssociatedTokenAddress)(userOutMint, wallet.publicKey, false)
        ]);
        const priorityFeeEstimate = generalSettings.fees.fixedPriorityFee || DEFAULT_PRIORITY_FEE;
        const instructions = [];
        // Add compute budget instructions
        instructions.push(web3_js_1.ComputeBudgetProgram.setComputeUnitLimit({ units: 200000 }), web3_js_1.ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFeeEstimate }));
        // Add Jito tip
        instructions.push(await (0, jito_1.prepareJitoTip)(priorityFeeEstimate, wallet.publicKey, false));
        // Create ATAs
        instructions.push((0, spl_token_1.createAssociatedTokenAccountIdempotentInstruction)(wallet.publicKey, userInAddress, wallet.publicKey, userInMint), (0, spl_token_1.createAssociatedTokenAccountIdempotentInstruction)(wallet.publicKey, userOutAddress, wallet.publicKey, userOutMint), (0, spl_token_1.createAssociatedTokenAccountIdempotentInstruction)(wallet.publicKey, userWSOLAddress, wallet.publicKey, spl_token_1.NATIVE_MINT));
        // Handle SOL wrapping for buys
        if (swapData.isBuy) {
            instructions.push(web3_js_1.SystemProgram.transfer({
                fromPubkey: wallet.publicKey,
                toPubkey: userWSOLAddress,
                lamports: amountIn
            }), (0, spl_token_1.createSyncNativeInstruction)(userWSOLAddress));
        }
        // Calculate swap amounts
        const { expectedOutput } = calculateSwapOutput(amountIn, swapData.poolBalances, tokenDecimals);
        const minAmountOut = Math.floor(expectedOutput * (1 - slippageTolerance - POOL_FEE_BUFFER));
        console.log(chalk_1.default.hex(config_1.COLORS.PRIMARY)('\nSwap Parameters:'));
        console.log(`Input Amount: ${amountIn / web3_js_1.LAMPORTS_PER_SOL} SOL`);
        console.log(`Expected Output: ${expectedOutput}`);
        console.log(`Minimum Output: ${minAmountOut}`);
        console.log(`Slippage: ${slippageTolerance * 100}%`);
        const amountInBN = new bn_js_1.default(amountIn.toString());
        const minAmountOutBN = new bn_js_1.default(minAmountOut.toString());
        const userInputAccount = swapData.isBuy ? userWSOLAddress : userInAddress;
        const userOutputAccount = swapData.isBuy ? userOutAddress : userWSOLAddress;
        // Build and add swap instruction
        instructions.push(await (0, swapBuilder_1.buildSwapInstruction)(wallet.publicKey, userInputAccount, userOutputAccount, {
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
        }, amountInBN, minAmountOutBN, true));
        // Add WSOL cleanup for sells
        if (!swapData.isBuy) {
            instructions.push((0, spl_token_1.createCloseAccountInstruction)(userWSOLAddress, wallet.publicKey, wallet.publicKey));
        }
        // Build and sign transaction
        const messageV0 = new web3_js_1.TransactionMessage({
            payerKey: wallet.publicKey,
            recentBlockhash: blockhash,
            instructions
        }).compileToV0Message();
        const transaction = new web3_js_1.VersionedTransaction(messageV0);
        transaction.sign([wallet]);
        console.log(chalk_1.default.hex(config_1.COLORS.PRIMARY)('\nSending transaction...'));
        const signature = await (0, jito_1.sendJitoTransaction)(transaction, { skipPreflight: true });
        console.log(chalk_1.default.hex(config_1.COLORS.PRIMARY)('Awaiting confirmation...'));
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
        console.log(chalk_1.default.hex(config_1.COLORS.SUCCESS)('\nTransaction successful!'));
        console.log(`Signature: ${chalk_1.default.hex(config_1.COLORS.ACCENT)(signature)}`);
        console.log(`Explorer: ${chalk_1.default.hex(config_1.COLORS.ACCENT)(`https://solscan.io/tx/${signature}`)}`);
        if (swapData.isBuy) {
            await handlePostTradePortfolioUpdate(connection, wallet, signature, swapData, amountIn, userOutputAccount, tokenDecimals);
        }
        return signature;
    }
    catch (error) {
        console.error(chalk_1.default.hex(config_1.COLORS.ERROR)('\nSwap failed:'), error);
        throw error;
    }
}
