"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.deriveInstructionDiscriminator = deriveInstructionDiscriminator;
exports.isPumpFunToken = isPumpFunToken;
exports.calculateCurrentPrice = calculateCurrentPrice;
exports.swapSolToPumpToken = swapSolToPumpToken;
exports.swapPumpTokenToSol = swapPumpTokenToSol;
//pumpSwap.ts
const web3_js_1 = require("@solana/web3.js");
const spl_token_1 = require("@solana/spl-token");
const spl_token_2 = require("@solana/spl-token");
const bn_js_1 = __importDefault(require("bn.js"));
const crypto_1 = require("crypto");
const chalk_1 = __importDefault(require("chalk"));
const constants_1 = require("./constants");
const jito_1 = require("../fees/jito");
const tokenTypeCache_1 = require("../pools/tokenTypeCache");
const portfolioTracker_1 = require("../positions/portfolioTracker");
const settingsManager_1 = require("../../cli/utils/settingsManager");
const blockhashManager_1 = require("./blockhashManager");
const config_1 = require("../../cli/config");
// Constants
const CACHE_DURATION = 30 * 1000;
const MAX_RETRIES = 2;
const RETRY_DELAY = 1000;
// Global cache and discriminators
const coinDataCache = {};
const BUY_IX_DISCRIMINATOR = deriveInstructionDiscriminator('global', 'buy');
const SELL_IX_DISCRIMINATOR = deriveInstructionDiscriminator('global', 'sell');
function deriveInstructionDiscriminator(nameSpace, ixName) {
    const hash = (0, crypto_1.createHash)('sha256')
        .update(`${nameSpace}:${ixName}`)
        .digest();
    return Buffer.from(hash.slice(0, 8));
}
function deriveBondingCurvePda(mint) {
    const [pda] = web3_js_1.PublicKey.findProgramAddressSync([Buffer.from("bonding-curve"), mint.toBuffer()], constants_1.PUMP_FUN_PROGRAM_ID);
    return pda;
}
async function deriveAssociatedBondingCurvePda(mint) {
    const bondingCurve = deriveBondingCurvePda(mint);
    return await (0, spl_token_1.getAssociatedTokenAddress)(mint, bondingCurve, true);
}
async function readBondingCurveAccount(connection, bondingCurvePk) {
    const accountInfo = await connection.getAccountInfo(bondingCurvePk);
    if (!accountInfo) {
        throw new Error(chalk_1.default.hex(config_1.COLORS.ERROR) `BondingCurve account not found: ${bondingCurvePk}`);
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
function calculateExpectedOutput(amountIn, coinData) {
    const virtualTokenReserves = new bn_js_1.default(coinData.virtual_token_reserves);
    const virtualSolReserves = new bn_js_1.default(coinData.virtual_sol_reserves);
    const numerator = virtualTokenReserves.mul(amountIn);
    const denominator = virtualSolReserves.add(amountIn);
    return numerator.div(denominator);
}
function calculateExpectedSolOutput(amountIn, coinData) {
    const virtualTokenReserves = new bn_js_1.default(coinData.virtual_token_reserves);
    const virtualSolReserves = new bn_js_1.default(coinData.virtual_sol_reserves);
    const numerator = virtualSolReserves.mul(amountIn);
    const denominator = virtualTokenReserves.add(amountIn);
    return numerator.div(denominator);
}
function validateBondingCurveState(coinData) {
    if (!coinData) {
        throw new Error(chalk_1.default.hex(config_1.COLORS.ERROR)("Invalid coin data"));
    }
    if (coinData.completed === true) {
        throw new Error(chalk_1.default.hex(config_1.COLORS.ERROR)("Token has already migrated from pump.fun"));
    }
    if (!new bn_js_1.default(coinData.virtual_token_reserves).gt(new bn_js_1.default(0))) {
        throw new Error(chalk_1.default.hex(config_1.COLORS.ERROR)("Virtual token reserves must be greater than 0"));
    }
    if (!new bn_js_1.default(coinData.virtual_sol_reserves).gt(new bn_js_1.default(0))) {
        throw new Error(chalk_1.default.hex(config_1.COLORS.ERROR)("Virtual SOL reserves must be greater than 0"));
    }
    try {
        new web3_js_1.PublicKey(coinData.bonding_curve);
        new web3_js_1.PublicKey(coinData.associated_bonding_curve);
    }
    catch {
        throw new Error(chalk_1.default.hex(config_1.COLORS.ERROR)("Invalid bonding curve addresses"));
    }
}
async function getCoinData(mintStr, forceRefresh = false) {
    const cached = coinDataCache[mintStr];
    if (!forceRefresh && cached && Date.now() - cached.timestamp < CACHE_DURATION) {
        return cached.data;
    }
    let lastError = null;
    for (let i = 0; i <= MAX_RETRIES; i++) {
        try {
            if (i > 0) {
                await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
            }
            const response = await fetch(`https://frontend-api.pump.fun/coins/${mintStr}`, {
                headers: {
                    "User-Agent": "Mozilla/5.0",
                    "Accept": "*/*",
                    "Referer": "https://www.pump.fun/",
                    "Origin": "https://www.pump.fun"
                }
            });
            if (response.status === 404)
                return null;
            if (!response.ok)
                throw new Error(chalk_1.default.hex(config_1.COLORS.ERROR)(`API error: ${response.status}`));
            const data = await response.json();
            if (data.completed === true || !data.bonding_curve || !data.associated_bonding_curve) {
                return null;
            }
            if (!data.virtual_token_reserves || !data.virtual_sol_reserves) {
                throw new Error(chalk_1.default.hex(config_1.COLORS.ERROR)("Invalid coin data format"));
            }
            try {
                new web3_js_1.PublicKey(data.bonding_curve);
                new web3_js_1.PublicKey(data.associated_bonding_curve);
            }
            catch {
                throw new Error(chalk_1.default.hex(config_1.COLORS.ERROR)("Invalid public key in coin data"));
            }
            if (new bn_js_1.default(data.virtual_token_reserves).lten(0) ||
                new bn_js_1.default(data.virtual_sol_reserves).lten(0)) {
                return null;
            }
            coinDataCache[mintStr] = { data, timestamp: Date.now() };
            return data;
        }
        catch (err) {
            lastError = err;
            if (i === MAX_RETRIES)
                throw err;
        }
    }
    throw lastError;
}
async function isPumpFunToken(connection, tokenAddress) {
    const addressStr = tokenAddress instanceof web3_js_1.PublicKey ?
        tokenAddress.toString() :
        tokenAddress;
    if (!addressStr.endsWith('pump')) {
        tokenTypeCache_1.TokenTypeCache.getInstance().setTokenType(addressStr, 'regular');
        return { isPump: false, hasMigrated: false };
    }
    const cachedInfo = tokenTypeCache_1.TokenTypeCache.getInstance().getTokenType(addressStr);
    if (cachedInfo) {
        if (cachedInfo.type === 'regular')
            return { isPump: false, hasMigrated: false };
        if (cachedInfo.type === 'migratedPump')
            return { isPump: false, hasMigrated: true };
    }
    try {
        const bondingCurvePk = deriveBondingCurvePda(new web3_js_1.PublicKey(addressStr));
        const bondingCurveInfo = await connection.getAccountInfo(bondingCurvePk);
        if (!bondingCurveInfo) {
            tokenTypeCache_1.TokenTypeCache.getInstance().setTokenType(addressStr, 'regular');
            return { isPump: false, hasMigrated: false };
        }
        if (!bondingCurveInfo.owner.equals(constants_1.PUMP_FUN_PROGRAM_ID)) {
            tokenTypeCache_1.TokenTypeCache.getInstance().setTokenType(addressStr, 'regular');
            return { isPump: false, hasMigrated: false };
        }
        try {
            const bondingCurveData = await readBondingCurveAccount(connection, bondingCurvePk);
            if (bondingCurveData.completed) {
                tokenTypeCache_1.TokenTypeCache.getInstance().setTokenType(addressStr, 'migratedPump');
                return { isPump: false, hasMigrated: true };
            }
            if (new bn_js_1.default(bondingCurveData.virtual_token_reserves).lten(0) ||
                new bn_js_1.default(bondingCurveData.virtual_sol_reserves).lten(0)) {
                tokenTypeCache_1.TokenTypeCache.getInstance().setTokenType(addressStr, 'regular');
                return { isPump: false, hasMigrated: false };
            }
            return { isPump: true, hasMigrated: false };
        }
        catch (error) {
            tokenTypeCache_1.TokenTypeCache.getInstance().setTokenType(addressStr, 'regular');
            return { isPump: false, hasMigrated: false };
        }
    }
    catch (error) {
        console.error(chalk_1.default.hex(config_1.COLORS.ERROR)('Error in isPumpFunToken:'), error);
        tokenTypeCache_1.TokenTypeCache.getInstance().setTokenType(addressStr, 'regular');
        return { isPump: false, hasMigrated: false };
    }
}
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
        { pubkey: spl_token_2.ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: spl_token_1.TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: constants_1.PUMP_FUN_ACCOUNT, isSigner: false, isWritable: false },
        { pubkey: constants_1.PUMP_FUN_PROGRAM_ID, isSigner: false, isWritable: false }
    ];
    return new web3_js_1.TransactionInstruction({ programId: constants_1.PUMP_FUN_PROGRAM_ID, keys, data });
}
function calculateCurrentPrice(coinData) {
    const virtualTokenReserves = new bn_js_1.default(coinData.virtual_token_reserves);
    const virtualSolReserves = new bn_js_1.default(coinData.virtual_sol_reserves);
    const reserves_ratio = Number(virtualSolReserves.toString()) / Number(virtualTokenReserves.toString());
    return reserves_ratio / 1000;
}
function formatError(error) {
    const message = error.message || String(error);
    if (message.includes("No liquidity pool found")) {
        return new Error(chalk_1.default.hex(config_1.COLORS.ERROR)("No liquidity pool exists for this token pair"));
    }
    if (message.includes("insufficient funds")) {
        return new Error(chalk_1.default.hex(config_1.COLORS.ERROR)("Insufficient funds for swap"));
    }
    if (message.includes("exceeds desired slippage limit")) {
        return new Error(chalk_1.default.hex(config_1.COLORS.ERROR)("Price impact too high. Try increasing slippage tolerance or reducing amount"));
    }
    if (message.includes("0x1")) {
        return new Error(chalk_1.default.hex(config_1.COLORS.ERROR)("Transaction failed - check token contract and pool status"));
    }
    if (message.includes("TooLittleSolReceived")) {
        return new Error(chalk_1.default.hex(config_1.COLORS.ERROR)("Price impact too high. Try reducing the amount or increasing slippage tolerance"));
    }
    if (message.includes("BondingCurveComplete")) {
        return new Error(chalk_1.default.hex(config_1.COLORS.ERROR)("This token has already migrated to Raydium"));
    }
    if (message.includes("NoTokenBalance")) {
        return new Error(chalk_1.default.hex(config_1.COLORS.ERROR)("No tokens found in your account"));
    }
    return error;
}
async function swapSolToPumpToken(connection, wallet, outputToken, amountInSol, slippageTolerance = 0.10) {
    if (amountInSol <= 0)
        throw new Error(chalk_1.default.hex(config_1.COLORS.ERROR)("Amount must be greater than 0"));
    let attempts = 0;
    const MAX_RETRY = 2;
    while (attempts < MAX_RETRY) {
        try {
            const bondingCurvePk = deriveBondingCurvePda(outputToken);
            const associatedBondingCurvePk = await deriveAssociatedBondingCurvePda(outputToken);
            const userTokenAccount = await (0, spl_token_1.getAssociatedTokenAddress)(outputToken, wallet.publicKey);
            const settings = settingsManager_1.SettingsManager.getInstance().getSettings();
            const [bondingCurveData, preTokenAccount, tokenAccountInfo, preBalance, { blockhash, lastValidBlockHeight }] = await Promise.all([
                readBondingCurveAccount(connection, bondingCurvePk),
                connection.getParsedTokenAccountsByOwner(wallet.publicKey, { mint: outputToken }),
                connection.getAccountInfo(userTokenAccount, "processed"),
                connection.getBalance(wallet.publicKey, "processed"),
                blockhashManager_1.BlockhashManager.getInstance().getBlockhash()
            ]);
            const coinData = {
                bonding_curve: bondingCurvePk.toBase58(),
                associated_bonding_curve: associatedBondingCurvePk.toBase58(),
                virtual_token_reserves: bondingCurveData.virtual_token_reserves,
                virtual_sol_reserves: bondingCurveData.virtual_sol_reserves,
                completed: bondingCurveData.completed
            };
            validateBondingCurveState(coinData);
            const preTokenBalance = preTokenAccount.value[0]?.account.data.parsed.info.tokenAmount.amount || '0';
            let priorityFeeEstimate = settings.fees.useAutomaticPriorityFee ?
                await getPriorityFee(connection) :
                settings.fees.fixedPriorityFee || 100000;
            const amountInLamports = Math.floor(amountInSol * web3_js_1.LAMPORTS_PER_SOL);
            const amountInBN = new bn_js_1.default(amountInLamports.toString());
            const expectedOutput = calculateExpectedOutput(amountInBN, coinData);
            const maxSolCost = amountInBN.muln(Math.floor((1 + slippageTolerance) * 1000)).divn(1000);
            const instructions = [
                web3_js_1.ComputeBudgetProgram.setComputeUnitLimit({ units: 200000 }),
                web3_js_1.ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFeeEstimate }),
                await (0, jito_1.prepareJitoTip)(priorityFeeEstimate, wallet.publicKey, false)
            ];
            if (!tokenAccountInfo) {
                instructions.push((0, spl_token_1.createAssociatedTokenAccountInstruction)(wallet.publicKey, userTokenAccount, wallet.publicKey, outputToken));
            }
            instructions.push(await buildPumpBuyInstruction(wallet.publicKey, userTokenAccount, outputToken, coinData, expectedOutput, maxSolCost));
            const messageV0 = new web3_js_1.TransactionMessage({
                payerKey: wallet.publicKey,
                recentBlockhash: blockhash,
                instructions
            }).compileToV0Message();
            const transaction = new web3_js_1.VersionedTransaction(messageV0);
            transaction.sign([wallet]);
            const signature = await (0, jito_1.sendJitoTransaction)(transaction, { skipPreflight: true });
            await connection.confirmTransaction({
                signature,
                blockhash,
                lastValidBlockHeight
            }, "processed");
            console.log(chalk_1.default.hex(config_1.COLORS.SUCCESS)(`Transaction confirmed: https://solscan.io/tx/${signature}`));
            // Record metrics and position
            try {
                await new Promise(resolve => setTimeout(resolve, 1000));
                const [postTokenAccount, postBondingCurveData] = await Promise.all([
                    connection.getParsedTokenAccountsByOwner(wallet.publicKey, { mint: outputToken }),
                    readBondingCurveAccount(connection, bondingCurvePk)
                ]);
                const postTokenBalance = postTokenAccount.value[0]?.account.data.parsed.info.tokenAmount.amount || '0';
                const tokensReceived = (Number(postTokenBalance) - Number(preTokenBalance)) / Math.pow(10, 6);
                const postCoinData = {
                    bonding_curve: bondingCurvePk.toBase58(),
                    associated_bonding_curve: associatedBondingCurvePk.toBase58(),
                    virtual_token_reserves: postBondingCurveData.virtual_token_reserves,
                    virtual_sol_reserves: postBondingCurveData.virtual_sol_reserves,
                    completed: postBondingCurveData.completed
                };
                const exitPrice = calculateCurrentPrice(postCoinData);
                await portfolioTracker_1.PortfolioTracker.getInstance().addPosition(outputToken.toString(), amountInSol, tokensReceived, signature, {
                    entryPriceOverride: exitPrice,
                    isPumpToken: true
                });
            }
            catch (err) {
                console.log(chalk_1.default.hex(config_1.COLORS.ERROR)('Failed to record position metrics'));
            }
            return signature;
        }
        catch (error) {
            if ((error.message?.includes("6002") ||
                error.message?.includes("Too much SOL required")) &&
                attempts < MAX_RETRY - 1) {
                attempts++;
                await new Promise(resolve => setTimeout(resolve, 1000));
                continue;
            }
            throw formatError(error);
        }
    }
    throw new Error(chalk_1.default.hex(config_1.COLORS.ERROR)("Max retry attempts reached"));
}
async function swapPumpTokenToSol(connection, wallet, inputToken, percentageToSell, slippageTolerance = 0.2) {
    if (percentageToSell <= 0 || percentageToSell > 100) {
        throw new Error(chalk_1.default.hex(config_1.COLORS.ERROR)("Percentage must be between 0 and 100"));
    }
    let attempts = 0;
    const MAX_RETRY = 2;
    while (attempts < MAX_RETRY) {
        try {
            const bondingCurvePk = deriveBondingCurvePda(inputToken);
            const associatedBondingCurvePk = await deriveAssociatedBondingCurvePda(inputToken);
            const userTokenAccount = await (0, spl_token_1.getAssociatedTokenAddress)(inputToken, wallet.publicKey);
            const settings = settingsManager_1.SettingsManager.getInstance().getSettings();
            const [bondingCurveData, { blockhash, lastValidBlockHeight }, tokenAccountInfo, preBalance] = await Promise.all([
                readBondingCurveAccount(connection, bondingCurvePk),
                blockhashManager_1.BlockhashManager.getInstance().getBlockhash(),
                (0, spl_token_2.getAccount)(connection, userTokenAccount),
                connection.getBalance(wallet.publicKey, "processed")
            ]);
            const coinData = {
                bonding_curve: bondingCurvePk.toBase58(),
                associated_bonding_curve: associatedBondingCurvePk.toBase58(),
                virtual_token_reserves: bondingCurveData.virtual_token_reserves,
                virtual_sol_reserves: bondingCurveData.virtual_sol_reserves,
                completed: bondingCurveData.completed
            };
            validateBondingCurveState(coinData);
            if (!tokenAccountInfo) {
                throw new Error(chalk_1.default.hex(config_1.COLORS.ERROR)("No token account found or insufficient balance"));
            }
            const tokenBalance = Number(tokenAccountInfo.amount);
            const amountToSell = Math.floor(tokenBalance * (percentageToSell / 100));
            if (amountToSell <= 0) {
                throw new Error(chalk_1.default.hex(config_1.COLORS.ERROR)("Calculated sell amount is too small"));
            }
            const amountToSellBN = new bn_js_1.default(amountToSell.toString());
            const expectedSolOutput = calculateExpectedSolOutput(amountToSellBN, coinData);
            const minSolOutput = expectedSolOutput.muln(Math.floor((1 - slippageTolerance) * 1000)).divn(1000);
            let priorityFeeEstimate = settings.fees.useAutomaticPriorityFee ?
                await getPriorityFee(connection) :
                settings.fees.fixedPriorityFee || 100000;
            const instructions = [
                web3_js_1.ComputeBudgetProgram.setComputeUnitLimit({ units: 200000 }),
                web3_js_1.ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFeeEstimate }),
                await (0, jito_1.prepareJitoTip)(priorityFeeEstimate, wallet.publicKey, false),
                await buildPumpSellInstruction(wallet.publicKey, userTokenAccount, inputToken, coinData, amountToSellBN, minSolOutput)
            ];
            const messageV0 = new web3_js_1.TransactionMessage({
                payerKey: wallet.publicKey,
                recentBlockhash: blockhash,
                instructions
            }).compileToV0Message();
            const transaction = new web3_js_1.VersionedTransaction(messageV0);
            transaction.sign([wallet]);
            const signature = await (0, jito_1.sendJitoTransaction)(transaction, { skipPreflight: true });
            await connection.confirmTransaction({
                signature,
                blockhash,
                lastValidBlockHeight
            }, "processed");
            console.log(chalk_1.default.hex(config_1.COLORS.SUCCESS)(`Transaction confirmed: https://solscan.io/tx/${signature}`));
            // Record metrics and position
            try {
                await new Promise(resolve => setTimeout(resolve, 1000));
                const [postBalance, postBondingCurveData] = await Promise.all([
                    connection.getBalance(wallet.publicKey),
                    readBondingCurveAccount(connection, bondingCurvePk)
                ]);
                const solReceived = (postBalance - preBalance) / web3_js_1.LAMPORTS_PER_SOL;
                const amountToSellHuman = amountToSell / Math.pow(10, 6);
                const postCoinData = {
                    bonding_curve: bondingCurvePk.toBase58(),
                    associated_bonding_curve: associatedBondingCurvePk.toBase58(),
                    virtual_token_reserves: postBondingCurveData.virtual_token_reserves,
                    virtual_sol_reserves: postBondingCurveData.virtual_sol_reserves,
                    completed: postBondingCurveData.completed
                };
                const exitPrice = calculateCurrentPrice(postCoinData);
                await portfolioTracker_1.PortfolioTracker.getInstance().addPosition(inputToken.toString(), -solReceived, -amountToSellHuman, signature, {
                    entryPriceOverride: exitPrice,
                    isPumpToken: true
                });
            }
            catch (err) {
                console.log(chalk_1.default.hex(config_1.COLORS.ERROR)('Failed to record position metrics'));
            }
            return signature;
        }
        catch (error) {
            if ((error.message?.includes("6002") ||
                error.message?.includes("Too much SOL required")) &&
                attempts < MAX_RETRY - 1) {
                attempts++;
                await new Promise(resolve => setTimeout(resolve, 1000));
                continue;
            }
            throw formatError(error);
        }
    }
    throw new Error("Max retry attempts reached");
}
async function getPriorityFee(connection) {
    try {
        const response = await fetch(connection.rpcEndpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 'helius-priority-fee',
                method: 'getPriorityFeeEstimate',
                params: [{
                        options: {
                            priorityLevel: "High",
                            evaluateEmptySlotAsZero: true
                        }
                    }]
            })
        });
        if (response.ok) {
            const data = await response.json();
            return data?.result?.priorityFeeEstimate || 100000;
        }
    }
    catch (error) {
        console.error(chalk_1.default.hex(config_1.COLORS.ERROR)('Priority fee estimation failed:'), error);
    }
    return 100000;
}
