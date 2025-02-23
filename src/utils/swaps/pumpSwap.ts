//pumpSwap.ts
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
    createAssociatedTokenAccountInstruction
} from "@solana/spl-token";
import { NATIVE_MINT, ASSOCIATED_TOKEN_PROGRAM_ID, getAccount as getTokenAccount } from "@solana/spl-token";
import BN from 'bn.js';
import { createHash } from 'crypto';
import chalk from 'chalk';
import { 
    PUMP_FUN_PROGRAM_ID,
    FEE_RECIPIENT,
    GLOBAL,
    PUMP_FUN_ACCOUNT,
} from './constants';
import { sendJitoTransaction, prepareJitoTip } from '../fees/jito';
import { tokenTracker } from "../positions/tokenTracker";
import { TokenTypeCache } from "../pools/tokenTypeCache";
import { PortfolioTracker } from '../positions/portfolioTracker';
import { SettingsManager } from "../../cli/utils/settingsManager";
import { BlockhashManager } from './blockhashManager';
import { COLORS } from "../../cli/config";

// Types
interface CoinData {
    bonding_curve: string;
    associated_bonding_curve: string;
    virtual_token_reserves: string;
    virtual_sol_reserves: string;
    completed?: boolean;
}

interface BondingCurveData {
    virtual_token_reserves: string;
    virtual_sol_reserves: string;
    real_token_reserves: string;
    real_sol_reserves: string;
    token_total_supply: string;
    completed: boolean;
}

interface CacheEntry {
    data: CoinData;
    timestamp: number;
}

// Constants
const CACHE_DURATION = 30 * 1000;
const MAX_RETRIES = 2;
const RETRY_DELAY = 1000;

// Global cache and discriminators
const coinDataCache: { [key: string]: CacheEntry } = {};
const BUY_IX_DISCRIMINATOR = deriveInstructionDiscriminator('global', 'buy');
const SELL_IX_DISCRIMINATOR = deriveInstructionDiscriminator('global', 'sell');

export function deriveInstructionDiscriminator(nameSpace: string, ixName: string): Buffer {
    const hash = createHash('sha256')
        .update(`${nameSpace}:${ixName}`)
        .digest();
    return Buffer.from(hash.slice(0, 8));
}

function deriveBondingCurvePda(mint: PublicKey): PublicKey {
    const [pda] = PublicKey.findProgramAddressSync(
        [Buffer.from("bonding-curve"), mint.toBuffer()],
        PUMP_FUN_PROGRAM_ID
    );
    return pda;
}

async function deriveAssociatedBondingCurvePda(mint: PublicKey): Promise<PublicKey> {
    const bondingCurve = deriveBondingCurvePda(mint);
    return await getAssociatedTokenAddress(mint, bondingCurve, true);
}

async function readBondingCurveAccount(connection: Connection, bondingCurvePk: PublicKey): Promise<BondingCurveData> {
    const accountInfo = await connection.getAccountInfo(bondingCurvePk);
    if (!accountInfo) {
        throw new Error(chalk.hex(COLORS.ERROR)`BondingCurve account not found: ${bondingCurvePk}`);
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

function calculateExpectedOutput(amountIn: BN, coinData: CoinData): BN {
    const virtualTokenReserves = new BN(coinData.virtual_token_reserves);
    const virtualSolReserves = new BN(coinData.virtual_sol_reserves);
    
    const numerator = virtualTokenReserves.mul(amountIn);
    const denominator = virtualSolReserves.add(amountIn);
    
    return numerator.div(denominator);
}

function calculateExpectedSolOutput(amountIn: BN, coinData: CoinData): BN {
    const virtualTokenReserves = new BN(coinData.virtual_token_reserves);
    const virtualSolReserves = new BN(coinData.virtual_sol_reserves);
    
    const numerator = virtualSolReserves.mul(amountIn);
    const denominator = virtualTokenReserves.add(amountIn);
    
    return numerator.div(denominator);
}

function validateBondingCurveState(coinData: CoinData): void {
    if (!coinData) {
        throw new Error(chalk.hex(COLORS.ERROR)("Invalid coin data"));
    }

    if (coinData.completed === true) {
        throw new Error(chalk.hex(COLORS.ERROR)("Token has already migrated from pump.fun"));
    }

    if (!new BN(coinData.virtual_token_reserves).gt(new BN(0))) {
        throw new Error(chalk.hex(COLORS.ERROR)("Virtual token reserves must be greater than 0"));
    }
    
    if (!new BN(coinData.virtual_sol_reserves).gt(new BN(0))) {
        throw new Error(chalk.hex(COLORS.ERROR)("Virtual SOL reserves must be greater than 0"));
    }

    try {
        new PublicKey(coinData.bonding_curve);
        new PublicKey(coinData.associated_bonding_curve);
    } catch {
        throw new Error(chalk.hex(COLORS.ERROR)("Invalid bonding curve addresses"));
    }
}

async function getCoinData(mintStr: string, forceRefresh: boolean = false): Promise<CoinData | null> {
    const cached = coinDataCache[mintStr];
    if (!forceRefresh && cached && Date.now() - cached.timestamp < CACHE_DURATION) {
        return cached.data;
    }

    let lastError: Error | null = null;
    
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

            if (response.status === 404) return null;
            if (!response.ok) throw new Error(chalk.hex(COLORS.ERROR)(`API error: ${response.status}`));

            const data: CoinData = await response.json();

            if (data.completed === true || !data.bonding_curve || !data.associated_bonding_curve) {
                return null;
            }

            if (!data.virtual_token_reserves || !data.virtual_sol_reserves) {
                throw new Error(chalk.hex(COLORS.ERROR)("Invalid coin data format"));
            }

            try {
                new PublicKey(data.bonding_curve);
                new PublicKey(data.associated_bonding_curve);
            } catch {
                throw new Error(chalk.hex(COLORS.ERROR)("Invalid public key in coin data"));
            }

            if (new BN(data.virtual_token_reserves).lten(0) || 
                new BN(data.virtual_sol_reserves).lten(0)) {
                return null;
            }

            coinDataCache[mintStr] = { data, timestamp: Date.now() };
            return data;
        } catch (err) {
            lastError = err as Error;
            if (i === MAX_RETRIES) throw err;
        }
    }

    throw lastError;
}

export async function isPumpFunToken(
    connection: Connection,
    tokenAddress: string | PublicKey
): Promise<{ isPump: boolean; hasMigrated: boolean }> {
    const addressStr = tokenAddress instanceof PublicKey ? 
        tokenAddress.toString() : 
        tokenAddress;

    if (!addressStr.endsWith('pump')) {
        TokenTypeCache.getInstance().setTokenType(addressStr, 'regular');
        return { isPump: false, hasMigrated: false };
    }

    const cachedInfo = TokenTypeCache.getInstance().getTokenType(addressStr);
    if (cachedInfo) {
        if (cachedInfo.type === 'regular') return { isPump: false, hasMigrated: false };
        if (cachedInfo.type === 'migratedPump') return { isPump: false, hasMigrated: true };
    }

    try {
        const bondingCurvePk = deriveBondingCurvePda(new PublicKey(addressStr));
        const bondingCurveInfo = await connection.getAccountInfo(bondingCurvePk);

        if (!bondingCurveInfo) {
            TokenTypeCache.getInstance().setTokenType(addressStr, 'regular');
            return { isPump: false, hasMigrated: false };
        }

        if (!bondingCurveInfo.owner.equals(PUMP_FUN_PROGRAM_ID)) {
            TokenTypeCache.getInstance().setTokenType(addressStr, 'regular');
            return { isPump: false, hasMigrated: false };
        }

        try {
            const bondingCurveData = await readBondingCurveAccount(connection, bondingCurvePk);

            if (bondingCurveData.completed) {
                TokenTypeCache.getInstance().setTokenType(addressStr, 'migratedPump');
                return { isPump: false, hasMigrated: true };
            }

            if (new BN(bondingCurveData.virtual_token_reserves).lten(0) || 
                new BN(bondingCurveData.virtual_sol_reserves).lten(0)) {
                TokenTypeCache.getInstance().setTokenType(addressStr, 'regular');
                return { isPump: false, hasMigrated: false };
            }

            return { isPump: true, hasMigrated: false };

        } catch (error) {
            TokenTypeCache.getInstance().setTokenType(addressStr, 'regular');
            return { isPump: false, hasMigrated: false };
        }

    } catch (error) {
        console.error(chalk.hex(COLORS.ERROR)('Error in isPumpFunToken:'), error);
        TokenTypeCache.getInstance().setTokenType(addressStr, 'regular');
        return { isPump: false, hasMigrated: false };
    }
}

async function buildPumpBuyInstruction(
    wallet: PublicKey,
    tokenAccount: PublicKey,
    mint: PublicKey,
    coinData: any,
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

    return new TransactionInstruction({ programId: PUMP_FUN_PROGRAM_ID, keys, data });
}

export function calculateCurrentPrice(coinData: any): number {
    const virtualTokenReserves = new BN(coinData.virtual_token_reserves);
    const virtualSolReserves = new BN(coinData.virtual_sol_reserves);
    
    const reserves_ratio = Number(virtualSolReserves.toString()) / Number(virtualTokenReserves.toString());
    return reserves_ratio / 1000;
}

function formatError(error: any): Error {
    const message = error.message || String(error);
    
    if (message.includes("No liquidity pool found")) {
        return new Error(chalk.hex(COLORS.ERROR)("No liquidity pool exists for this token pair"));
    }
    if (message.includes("insufficient funds")) {
        return new Error(chalk.hex(COLORS.ERROR)("Insufficient funds for swap"));
    }
    if (message.includes("exceeds desired slippage limit")) {
        return new Error(chalk.hex(COLORS.ERROR)("Price impact too high. Try increasing slippage tolerance or reducing amount"));
    }
    if (message.includes("0x1")) {
        return new Error(chalk.hex(COLORS.ERROR)("Transaction failed - check token contract and pool status"));
    }
    if (message.includes("TooLittleSolReceived")) {
        return new Error(chalk.hex(COLORS.ERROR)("Price impact too high. Try reducing the amount or increasing slippage tolerance"));
    }
    if (message.includes("BondingCurveComplete")) {
        return new Error(chalk.hex(COLORS.ERROR)("This token has already migrated to Raydium"));
    }
    if (message.includes("NoTokenBalance")) {
        return new Error(chalk.hex(COLORS.ERROR)("No tokens found in your account"));
    }
    
    return error;
}

export async function swapSolToPumpToken(
    connection: Connection,
    wallet: Keypair,
    outputToken: PublicKey,
    amountInSol: number,
    slippageTolerance: number = 0.10
): Promise<string> {
    if (amountInSol <= 0) throw new Error(chalk.hex(COLORS.ERROR)("Amount must be greater than 0"));
    
    let attempts = 0;
    const MAX_RETRY = 2;
    
    while (attempts < MAX_RETRY) {
        try {
            const bondingCurvePk = deriveBondingCurvePda(outputToken);
            const associatedBondingCurvePk = await deriveAssociatedBondingCurvePda(outputToken);
            const userTokenAccount = await getAssociatedTokenAddress(outputToken, wallet.publicKey);
            const settings = SettingsManager.getInstance().getSettings();
            
            const [
                bondingCurveData,
                preTokenAccount,
                tokenAccountInfo,
                preBalance,
                { blockhash, lastValidBlockHeight }
            ] = await Promise.all([
                readBondingCurveAccount(connection, bondingCurvePk),
                connection.getParsedTokenAccountsByOwner(wallet.publicKey, { mint: outputToken }),
                connection.getAccountInfo(userTokenAccount, "processed"),
                connection.getBalance(wallet.publicKey, "processed"),
                BlockhashManager.getInstance().getBlockhash()
            ]);

            const coinData: CoinData = {
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

            const amountInLamports = Math.floor(amountInSol * LAMPORTS_PER_SOL);
            const amountInBN = new BN(amountInLamports.toString());
            const expectedOutput = calculateExpectedOutput(amountInBN, coinData);
            const maxSolCost = amountInBN.muln(Math.floor((1 + slippageTolerance) * 1000)).divn(1000);

            const instructions: TransactionInstruction[] = [
                ComputeBudgetProgram.setComputeUnitLimit({ units: 200000 }),
                ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFeeEstimate }),
                await prepareJitoTip(priorityFeeEstimate, wallet.publicKey, false)
            ];

            if (!tokenAccountInfo) {
                instructions.push(
                    createAssociatedTokenAccountInstruction(
                        wallet.publicKey,
                        userTokenAccount,
                        wallet.publicKey,
                        outputToken
                    )
                );
            }

            instructions.push(
                await buildPumpBuyInstruction(
                    wallet.publicKey,
                    userTokenAccount,
                    outputToken,
                    coinData,
                    expectedOutput,
                    maxSolCost
                )
            );

            const messageV0 = new TransactionMessage({
                payerKey: wallet.publicKey,
                recentBlockhash: blockhash,
                instructions
            }).compileToV0Message();

            const transaction = new VersionedTransaction(messageV0);
            transaction.sign([wallet]);

            const signature = await sendJitoTransaction(transaction, { skipPreflight: true });
            
            await connection.confirmTransaction({
                signature,
                blockhash,
                lastValidBlockHeight
            }, "processed");

            console.log(chalk.hex(COLORS.SUCCESS)(`Transaction confirmed: https://solscan.io/tx/${signature}`));

            // Record metrics and position
            try {
                await new Promise(resolve => setTimeout(resolve, 1000));
                
                const [postTokenAccount, postBondingCurveData] = await Promise.all([
                    connection.getParsedTokenAccountsByOwner(wallet.publicKey, { mint: outputToken }),
                    readBondingCurveAccount(connection, bondingCurvePk)
                ]);

                const postTokenBalance = postTokenAccount.value[0]?.account.data.parsed.info.tokenAmount.amount || '0';
                const tokensReceived = (Number(postTokenBalance) - Number(preTokenBalance)) / Math.pow(10, 6);

                const postCoinData: CoinData = {
                    bonding_curve: bondingCurvePk.toBase58(),
                    associated_bonding_curve: associatedBondingCurvePk.toBase58(),
                    virtual_token_reserves: postBondingCurveData.virtual_token_reserves,
                    virtual_sol_reserves: postBondingCurveData.virtual_sol_reserves,
                    completed: postBondingCurveData.completed
                };

                const exitPrice = calculateCurrentPrice(postCoinData);

                await PortfolioTracker.getInstance().addPosition(
                    outputToken.toString(),
                    amountInSol,
                    tokensReceived,
                    signature,
                    {
                        entryPriceOverride: exitPrice,
                        isPumpToken: true
                    }
                );

            } catch (err) {
                console.log(chalk.hex(COLORS.ERROR)('Failed to record position metrics'));
            }

            return signature;

        } catch (error: any) {
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

    throw new Error(chalk.hex(COLORS.ERROR)("Max retry attempts reached"));
}

export async function swapPumpTokenToSol(
    connection: Connection,
    wallet: Keypair,
    inputToken: PublicKey,
    percentageToSell: number,
    slippageTolerance: number = 0.2
): Promise<string> {
    if (percentageToSell <= 0 || percentageToSell > 100) {
        throw new Error(chalk.hex(COLORS.ERROR)("Percentage must be between 0 and 100"));
    }

    let attempts = 0;
    const MAX_RETRY = 2;
    
    while (attempts < MAX_RETRY) {
        try {
            const bondingCurvePk = deriveBondingCurvePda(inputToken);
            const associatedBondingCurvePk = await deriveAssociatedBondingCurvePda(inputToken);
            const userTokenAccount = await getAssociatedTokenAddress(inputToken, wallet.publicKey);
            const settings = SettingsManager.getInstance().getSettings();

            const [
                bondingCurveData,
                { blockhash, lastValidBlockHeight },
                tokenAccountInfo,
                preBalance
            ] = await Promise.all([
                readBondingCurveAccount(connection, bondingCurvePk),
                BlockhashManager.getInstance().getBlockhash(),
                getTokenAccount(connection, userTokenAccount),
                connection.getBalance(wallet.publicKey, "processed")
            ]);

            const coinData: CoinData = {
                bonding_curve: bondingCurvePk.toBase58(),
                associated_bonding_curve: associatedBondingCurvePk.toBase58(),
                virtual_token_reserves: bondingCurveData.virtual_token_reserves,
                virtual_sol_reserves: bondingCurveData.virtual_sol_reserves,
                completed: bondingCurveData.completed
            };

            validateBondingCurveState(coinData);

            if (!tokenAccountInfo) {
                throw new Error(chalk.hex(COLORS.ERROR)("No token account found or insufficient balance"));
            }

            const tokenBalance = Number(tokenAccountInfo.amount);
            const amountToSell = Math.floor(tokenBalance * (percentageToSell / 100));
            
            if (amountToSell <= 0) {
                throw new Error(chalk.hex(COLORS.ERROR)("Calculated sell amount is too small"));
            }

            const amountToSellBN = new BN(amountToSell.toString());
            const expectedSolOutput = calculateExpectedSolOutput(amountToSellBN, coinData);
            const minSolOutput = expectedSolOutput.muln(Math.floor((1 - slippageTolerance) * 1000)).divn(1000);

            let priorityFeeEstimate = settings.fees.useAutomaticPriorityFee ? 
                await getPriorityFee(connection) : 
                settings.fees.fixedPriorityFee || 100000;

            const instructions: TransactionInstruction[] = [
                ComputeBudgetProgram.setComputeUnitLimit({ units: 200000 }),
                ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFeeEstimate }),
                await prepareJitoTip(priorityFeeEstimate, wallet.publicKey, false),
                await buildPumpSellInstruction(
                    wallet.publicKey,
                    userTokenAccount,
                    inputToken,
                    coinData,
                    amountToSellBN,
                    minSolOutput
                )
            ];

            const messageV0 = new TransactionMessage({
                payerKey: wallet.publicKey,
                recentBlockhash: blockhash,
                instructions
            }).compileToV0Message();

            const transaction = new VersionedTransaction(messageV0);
            transaction.sign([wallet]);

            const signature = await sendJitoTransaction(transaction, { skipPreflight: true });
            
            await connection.confirmTransaction({
                signature,
                blockhash,
                lastValidBlockHeight
            }, "processed");

            console.log(chalk.hex(COLORS.SUCCESS)(`Transaction confirmed: https://solscan.io/tx/${signature}`));

            // Record metrics and position
            try {
                await new Promise(resolve => setTimeout(resolve, 1000));
                
                const [postBalance, postBondingCurveData] = await Promise.all([
                    connection.getBalance(wallet.publicKey),
                    readBondingCurveAccount(connection, bondingCurvePk)
                ]);
                
                const solReceived = (postBalance - preBalance) / LAMPORTS_PER_SOL;
                const amountToSellHuman = amountToSell / Math.pow(10, 6);

                const postCoinData: CoinData = {
                    bonding_curve: bondingCurvePk.toBase58(),
                    associated_bonding_curve: associatedBondingCurvePk.toBase58(),
                    virtual_token_reserves: postBondingCurveData.virtual_token_reserves,
                    virtual_sol_reserves: postBondingCurveData.virtual_sol_reserves,
                    completed: postBondingCurveData.completed
                };

                const exitPrice = calculateCurrentPrice(postCoinData);

                await PortfolioTracker.getInstance().addPosition(
                    inputToken.toString(),
                    -solReceived,
                    -amountToSellHuman,
                    signature,
                    {
                        entryPriceOverride: exitPrice,
                        isPumpToken: true
                    }
                );

            } catch (err) {
                console.log(chalk.hex(COLORS.ERROR)('Failed to record position metrics'));
            }

            return signature;

        } catch (error: any) {
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

async function getPriorityFee(connection: Connection): Promise<number> {
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
    } catch (error) {
        console.error(chalk.hex(COLORS.ERROR)('Priority fee estimation failed:'), error);
    }
    
    return 100000;
}