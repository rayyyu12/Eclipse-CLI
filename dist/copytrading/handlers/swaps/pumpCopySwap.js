"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.copyPumpSellSwap = copyPumpSellSwap;
exports.copyPumpBuySwap = copyPumpBuySwap;
// -------------------------------------------------------------
// pumpCopySwap.ts (updated to always use createAssociatedTokenAccountIdempotentInstruction)
// -------------------------------------------------------------
const web3_js_1 = require("@solana/web3.js");
const spl_token_1 = require("@solana/spl-token");
const bn_js_1 = __importDefault(require("bn.js"));
const constants_1 = require("../../../utils/swaps/constants");
const crypto_1 = require("crypto");
const jito_1 = require("../../../utils/fees/jito");
const settingsManager_1 = require("../../../cli/utils/settingsManager");
const blockhashManager_1 = require("../../../utils/swaps/blockhashManager");
const portfolioTracker_1 = require("../../../utils/positions/portfolioTracker");
const copyTradingSettings_1 = require("../../../cli/utils/copyTradingSettings");
const chalk_1 = __importDefault(require("chalk"));
const config_1 = require("../../../cli/config");
// We add performance measurement from Node's perf_hooks
const perf_hooks_1 = require("perf_hooks");
// --------------------------------------------------------------------
// Utility code for reading the bonding curve on-chain
// (Adapted from your pumpSwap.ts logic)
// --------------------------------------------------------------------
function deriveInstructionDiscriminator(nameSpace, ixName) {
    const hash = (0, crypto_1.createHash)('sha256')
        .update(`${nameSpace}:${ixName}`)
        .digest();
    return Buffer.from(hash.slice(0, 8));
}
const BUY_IX_DISCRIMINATOR = deriveInstructionDiscriminator('global', 'buy');
const SELL_IX_DISCRIMINATOR = deriveInstructionDiscriminator('global', 'sell');
const DEFAULT_PRIORITY_FEE = 100000;
async function handlePostTradePortfolioUpdate(connection, wallet, signature, swapData, amountIn, userTokenAccount, isBuy) {
    try {
        const confirmation = await connection.confirmTransaction(signature);
        if (confirmation.value.err) {
            throw new Error('Transaction failed');
        }
        const tokenAccount = await connection.getParsedTokenAccountsByOwner(wallet.publicKey, { mint: swapData.tokenAddress });
        const currentBalance = tokenAccount.value[0]?.account.data.parsed.info.tokenAmount.uiAmount || 0;
        const portfolioTracker = portfolioTracker_1.PortfolioTracker.getInstance();
        if (isBuy) {
            await portfolioTracker.addPosition(swapData.tokenAddress.toString(), amountIn / web3_js_1.LAMPORTS_PER_SOL, currentBalance, signature, { isPumpToken: true });
        }
        else {
            await portfolioTracker.addPosition(swapData.tokenAddress.toString(), -(amountIn / web3_js_1.LAMPORTS_PER_SOL), -Math.abs(currentBalance), signature, { isPumpToken: true });
        }
        console.log(chalk_1.default.hex(config_1.COLORS.SUCCESS)('\nPortfolio update successful:'));
        console.log(`Token: ${swapData.tokenAddress.toString()}`);
        console.log(`Balance: ${currentBalance.toFixed(6)}`);
    }
    catch (error) {
        console.error(chalk_1.default.hex(config_1.COLORS.ERROR)('Portfolio update failed:'), error);
    }
}
// Add build sell instruction function
async function buildPumpSellInstruction(wallet, tokenAccount, mint, coinData, amount, minSolOutput) {
    const data = Buffer.concat([
        SELL_IX_DISCRIMINATOR,
        amount.toArrayLike(Buffer, 'le', 8),
        minSolOutput.toArrayLike(Buffer, 'le', 8)
    ]);
    const keys = [
        { pubkey: constants_1.GLOBAL, isSigner: false, isWritable: false },
        { pubkey: constants_1.FEE_RECIPIENT, isSigner: false, isWritable: true },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: new web3_js_1.PublicKey(coinData.bonding_curve), isSigner: false, isWritable: true },
        { pubkey: new web3_js_1.PublicKey(coinData.associated_bonding_curve), isSigner: false, isWritable: true },
        { pubkey: tokenAccount, isSigner: false, isWritable: true },
        { pubkey: wallet, isSigner: true, isWritable: true },
        { pubkey: web3_js_1.SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: spl_token_1.ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: spl_token_1.TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: constants_1.PUMP_FUN_ACCOUNT, isSigner: false, isWritable: false },
        { pubkey: constants_1.PUMP_FUN_PROGRAM_ID, isSigner: false, isWritable: false }
    ];
    return new web3_js_1.TransactionInstruction({ programId: constants_1.PUMP_FUN_PROGRAM_ID, keys, data });
}
// Add copy sell function
async function copyPumpSellSwap(connection, wallet, swapData, tokenAmount, slippageTolerance = 0.10) {
    const overallStart = perf_hooks_1.performance.now();
    console.log(chalk_1.default.hex(config_1.COLORS.PRIMARY)('\nInitiating pump.fun sell...'));
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
        const userTokenAccount = await (0, spl_token_1.getAssociatedTokenAddress)(swapData.tokenAddress, wallet.publicKey);
        // Step 4: Get blockhash and fees
        const { blockhash, lastValidBlockHeight } = await blockhashManager_1.BlockhashManager.getInstance().getBlockhash();
        const settings = settingsManager_1.SettingsManager.getInstance().getSettings();
        const priorityFeeEstimate = settings.fees.fixedPriorityFee || DEFAULT_PRIORITY_FEE;
        // Step 5: Calculate expected output
        const amountBN = new bn_js_1.default(tokenAmount.toString());
        const expectedOutput = calculateExpectedSolOutput(amountBN, coinData);
        const minSolOutput = expectedOutput.muln(Math.floor((1 - slippageTolerance) * 1000)).divn(1000);
        console.log(chalk_1.default.hex(config_1.COLORS.PRIMARY)('\nSell Parameters:'));
        console.log(`Amount In: ${tokenAmount} Tokens`);
        console.log(`Expected Output: ${(expectedOutput.toNumber() / web3_js_1.LAMPORTS_PER_SOL).toFixed(4)} SOL`);
        console.log(`Min Output: ${(minSolOutput.toNumber() / web3_js_1.LAMPORTS_PER_SOL).toFixed(4)} SOL`);
        console.log(`Slippage: ${(slippageTolerance * 100).toFixed(2)}%`);
        // Step 6: Build instructions
        const instructions = [
            web3_js_1.ComputeBudgetProgram.setComputeUnitLimit({ units: 200000 }),
            web3_js_1.ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFeeEstimate }),
            await (0, jito_1.prepareJitoTip)(priorityFeeEstimate, wallet.publicKey, false),
            await buildPumpSellInstruction(wallet.publicKey, userTokenAccount, swapData.tokenAddress, coinData, amountBN, minSolOutput)
        ];
        // Step 7: Build and send transaction
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
        }, "processed");
        console.log(chalk_1.default.hex(config_1.COLORS.SUCCESS)('\nTransaction successful!'));
        console.log(`Signature: ${chalk_1.default.hex(config_1.COLORS.ACCENT)(signature)}`);
        console.log(`Explorer: ${chalk_1.default.hex(config_1.COLORS.ACCENT)(`https://solscan.io/tx/${signature}`)}`);
        // Update portfolio
        await handlePostTradePortfolioUpdate(connection, wallet, signature, swapData, tokenAmount, userTokenAccount, false);
        console.log(chalk_1.default.hex(config_1.COLORS.PRIMARY)(`\nTotal execution time: ${(perf_hooks_1.performance.now() - overallStart).toFixed(2)}ms`));
        return signature;
    }
    catch (error) {
        console.error(chalk_1.default.hex(config_1.COLORS.ERROR)('\nTransaction failed:'), error);
        throw error;
    }
}
// Calculate expected SOL output for sells
function calculateExpectedSolOutput(amountIn, coinData) {
    const virtualTokenReserves = new bn_js_1.default(coinData.virtual_token_reserves);
    const virtualSolReserves = new bn_js_1.default(coinData.virtual_sol_reserves);
    const numerator = virtualSolReserves.mul(amountIn);
    const denominator = virtualTokenReserves.add(amountIn);
    return numerator.div(denominator);
}
function deriveBondingCurvePda(mint) {
    const [pda] = web3_js_1.PublicKey.findProgramAddressSync([
        Buffer.from("bonding-curve"),
        mint.toBuffer()
    ], constants_1.PUMP_FUN_PROGRAM_ID);
    return pda;
}
async function deriveAssociatedBondingCurvePda(mint) {
    const bondingCurve = deriveBondingCurvePda(mint);
    return await (0, spl_token_1.getAssociatedTokenAddress)(mint, bondingCurve, true);
}
async function readBondingCurveAccount(connection, bondingCurvePk) {
    const accountInfo = await connection.getAccountInfo(bondingCurvePk);
    if (!accountInfo) {
        throw new Error(`BondingCurve account not found: ${bondingCurvePk}`);
    }
    let offset = 8;
    const data = accountInfo.data;
    return {
        virtual_token_reserves: new bn_js_1.default(data.slice(offset, offset + 8), 'le').toString(),
        virtual_sol_reserves: new bn_js_1.default(data.slice(offset + 8, offset + 16), 'le').toString(),
        real_token_reserves: new bn_js_1.default(data.slice(offset + 16, offset + 24), 'le').toString(),
        real_sol_reserves: new bn_js_1.default(data.slice(offset + 24, offset + 32), 'le').toString(),
        token_total_supply: new bn_js_1.default(data.slice(offset + 32, offset + 40), 'le').toString(),
        completed: data[offset + 40] !== 0
    };
}
function calculateExpectedOutput(amountInLamports, coinData) {
    const virtualTokenReserves = new bn_js_1.default(coinData.virtual_token_reserves);
    const virtualSolReserves = new bn_js_1.default(coinData.virtual_sol_reserves);
    const numerator = virtualTokenReserves.mul(amountInLamports);
    const denominator = virtualSolReserves.add(amountInLamports);
    return numerator.div(denominator);
}
// We build the actual Pump buy instruction using on-chain data:
async function buildPumpBuyInstruction(wallet, tokenAccount, mint, coinData, expectedOutput, maxSolCost) {
    const data = Buffer.concat([
        BUY_IX_DISCRIMINATOR,
        expectedOutput.toArrayLike(Buffer, 'le', 8),
        maxSolCost.toArrayLike(Buffer, 'le', 8)
    ]);
    const keys = [
        { pubkey: constants_1.GLOBAL, isSigner: false, isWritable: false },
        { pubkey: constants_1.FEE_RECIPIENT, isSigner: false, isWritable: true },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: new web3_js_1.PublicKey(coinData.bonding_curve), isSigner: false, isWritable: true },
        { pubkey: new web3_js_1.PublicKey(coinData.associated_bonding_curve), isSigner: false, isWritable: true },
        { pubkey: tokenAccount, isSigner: false, isWritable: true },
        { pubkey: wallet, isSigner: true, isWritable: true },
        { pubkey: web3_js_1.SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: spl_token_1.TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: web3_js_1.SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
        { pubkey: constants_1.PUMP_FUN_ACCOUNT, isSigner: false, isWritable: false },
        { pubkey: constants_1.PUMP_FUN_PROGRAM_ID, isSigner: false, isWritable: false }
    ];
    return new web3_js_1.TransactionInstruction({ programId: constants_1.PUMP_FUN_PROGRAM_ID, keys, data });
}
// --------------------------------------------------------------------
// Main copy function
// --------------------------------------------------------------------
async function copyPumpBuySwap(connection, wallet, swapData, amountInLamports) {
    const settings = copyTradingSettings_1.CopyTradeSettingsManager.getInstance().getSettings();
    const slippageTolerance = settings.slippageTolerance.pump / 100;
    const overallStart = perf_hooks_1.performance.now();
    console.log(chalk_1.default.hex(config_1.COLORS.PRIMARY)('\nInitiating pump.fun buy...'));
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
        const userTokenAccount = await (0, spl_token_1.getAssociatedTokenAddress)(swapData.tokenAddress, wallet.publicKey);
        // Step 4: Get blockhash and fees
        const { blockhash, lastValidBlockHeight } = await blockhashManager_1.BlockhashManager.getInstance().getBlockhash();
        const settings = settingsManager_1.SettingsManager.getInstance().getSettings();
        const priorityFeeEstimate = settings.fees.fixedPriorityFee || DEFAULT_PRIORITY_FEE;
        // Step 5: Calculate expected output
        const ourSolAmountBN = new bn_js_1.default(amountInLamports.toString());
        const expectedOutputBN = calculateExpectedOutput(ourSolAmountBN, coinData);
        const maxSolCostBN = ourSolAmountBN.muln(Math.floor((1 + slippageTolerance) * 1000)).divn(1000);
        console.log(chalk_1.default.hex(config_1.COLORS.PRIMARY)('\nSwap Parameters:'));
        console.log(`Amount In: ${(amountInLamports / web3_js_1.LAMPORTS_PER_SOL).toFixed(4)} SOL`);
        console.log(`Expected Output: ${expectedOutputBN.toString()}`);
        console.log(`Max Cost: ${(maxSolCostBN.toNumber() / web3_js_1.LAMPORTS_PER_SOL).toFixed(4)} SOL`);
        console.log(`Slippage: ${(slippageTolerance * 100).toFixed(2)}%`);
        // Step 6: Build instructions
        const instructions = [
            web3_js_1.ComputeBudgetProgram.setComputeUnitLimit({ units: 200000 }),
            web3_js_1.ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFeeEstimate }),
            await (0, jito_1.prepareJitoTip)(priorityFeeEstimate, wallet.publicKey, false),
            (0, spl_token_1.createAssociatedTokenAccountIdempotentInstruction)(wallet.publicKey, userTokenAccount, wallet.publicKey, swapData.tokenAddress),
            await buildPumpBuyInstruction(wallet.publicKey, userTokenAccount, swapData.tokenAddress, coinData, expectedOutputBN, maxSolCostBN)
        ];
        // Step 7: Build and send transaction
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
        }, "processed");
        console.log(chalk_1.default.hex(config_1.COLORS.SUCCESS)('\nTransaction successful!'));
        console.log(`Signature: ${chalk_1.default.hex(config_1.COLORS.ACCENT)(signature)}`);
        console.log(`Explorer: ${chalk_1.default.hex(config_1.COLORS.ACCENT)(`https://solscan.io/tx/${signature}`)}`);
        // Update portfolio
        await handlePostTradePortfolioUpdate(connection, wallet, signature, swapData, amountInLamports, userTokenAccount, true);
        console.log(chalk_1.default.hex(config_1.COLORS.PRIMARY)(`\nTotal execution time: ${(perf_hooks_1.performance.now() - overallStart).toFixed(2)}ms`));
        return signature;
    }
    catch (error) {
        console.error(chalk_1.default.hex(config_1.COLORS.ERROR)('\nTransaction failed:'), error);
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
