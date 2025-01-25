// new pumpSwap.ts
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
import { PersistentPoolCache } from '../pools/persistentPoolCache';
import { discoverPool } from '../pools/poolDiscovery';
import { NATIVE_MINT, ASSOCIATED_TOKEN_PROGRAM_ID, getAccount as getTokenAccount } from "@solana/spl-token";
import BN from 'bn.js';
import { createHash } from 'crypto';
import { 
    PUMP_FUN_PROGRAM_ID,
    FEE_RECIPIENT,
    GLOBAL,
    PUMP_FUN_ACCOUNT 
} from './constants';
import { sendJitoTransaction, prepareJitoTip } from '../fees/jito';
import { tokenTracker } from "../positions/tokenTracker";
import { TokenTypeCache } from "../pools/tokenTypeCache";
import { PortfolioTracker } from '../positions/portfolioTracker';
import { SettingsManager } from "../../cli/utils/settingsManager";
import { BlockhashManager } from './blockhashManager';

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

// Global cache
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

function calculateExpectedOutput(amountIn: BN, coinData: CoinData): BN {
    console.log('\nCalculating expected output with:', {
        amountInLamports: amountIn.toString(),
        amountInSOL: amountIn.toNumber() / LAMPORTS_PER_SOL,
        virtualTokenReserves: coinData.virtual_token_reserves,
        virtualSolReserves: coinData.virtual_sol_reserves
    });

    const virtualTokenReserves = new BN(coinData.virtual_token_reserves);
    const virtualSolReserves = new BN(coinData.virtual_sol_reserves);
    
    console.log('Parsed BN values:', {
        virtualTokenReservesBN: virtualTokenReserves.toString(),
        virtualSolReservesBN: virtualSolReserves.toString()
    });
    
    const numerator = virtualTokenReserves.mul(amountIn);
    const denominator = virtualSolReserves.add(amountIn);
    
    console.log('Calculation steps:', {
        numerator: numerator.toString(),
        denominator: denominator.toString()
    });
    
    const result = numerator.div(denominator);
    
    console.log('Final result:', {
        expectedOutputRaw: result.toString(),
        expectedOutputAdjusted: result.toNumber() / Math.pow(10, 6)
    });
    
    return result;
}

function calculateExpectedSolOutput(amountIn: BN, coinData: CoinData): BN {
    const virtualTokenReserves = new BN(coinData.virtual_token_reserves);
    const virtualSolReserves = new BN(coinData.virtual_sol_reserves);
    
    // For selling, we use the inverse of the buying formula
    const numerator = virtualSolReserves.mul(amountIn);
    const denominator = virtualTokenReserves.add(amountIn);
    
    return numerator.div(denominator);
}

function validateBondingCurveState(coinData: CoinData): void {
    if (!coinData) {
        throw new Error("Invalid coin data");
    }

    if (coinData.completed === true) {
        throw new Error("Token has already migrated from pump.fun");
    }

    if (!new BN(coinData.virtual_token_reserves).gt(new BN(0))) {
        throw new Error("Virtual token reserves must be greater than 0");
    }
    
    if (!new BN(coinData.virtual_sol_reserves).gt(new BN(0))) {
        throw new Error("Virtual SOL reserves must be greater than 0");
    }

    try {
        new PublicKey(coinData.bonding_curve);
        new PublicKey(coinData.associated_bonding_curve);
    } catch {
        throw new Error("Invalid bonding curve addresses");
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

            if (response.status === 404) {
                return null;
            }

            if (!response.ok) {
                throw new Error(`API error: ${response.status}`);
            }

            const data: CoinData = await response.json();

            if (data.completed === true || !data.bonding_curve || !data.associated_bonding_curve) {
                return null;
            }

            if (!data.virtual_token_reserves || !data.virtual_sol_reserves) {
                throw new Error("Invalid coin data format");
            }

            try {
                new PublicKey(data.bonding_curve);
                new PublicKey(data.associated_bonding_curve);
            } catch {
                throw new Error("Invalid public key in coin data");
            }

            if (new BN(data.virtual_token_reserves).lten(0) || 
                new BN(data.virtual_sol_reserves).lten(0)) {
                return null;
            }

            coinDataCache[mintStr] = {
                data,
                timestamp: Date.now()
            };

            return data;
        } catch (err) {
            lastError = err as Error;
            if (i === MAX_RETRIES) {
                throw err;
            }
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

    console.log('Checking token type for:', addressStr);

    // Quick check for non-pump tokens based on naming
    if (!addressStr.endsWith('pump')) {
        console.log('Non-pump token detected, caching as regular token');
        TokenTypeCache.getInstance().setTokenType(addressStr, 'regular');
        return { isPump: false, hasMigrated: false };
    }

    // Check cache for known token types
    const cachedInfo = TokenTypeCache.getInstance().getTokenType(addressStr);
    if (cachedInfo) {
        console.log('Found cached token info:', cachedInfo);
        if (cachedInfo.type === 'regular') {
            return { isPump: false, hasMigrated: false };
        }
        if (cachedInfo.type === 'migratedPump') {
            return { isPump: false, hasMigrated: true };
        }
    }

    try {
        // First check if bonding curve account exists
        const bondingCurvePk = deriveBondingCurvePda(new PublicKey(addressStr));
        const bondingCurveInfo = await connection.getAccountInfo(bondingCurvePk);

        if (!bondingCurveInfo) {
            // No bonding curve account found - not a pump token
            console.log('No bonding curve account found, token is not a pump token');
            TokenTypeCache.getInstance().setTokenType(addressStr, 'regular');
            return { isPump: false, hasMigrated: false };
        }

        // Account exists, check if it's owned by the pump program
        if (!bondingCurveInfo.owner.equals(PUMP_FUN_PROGRAM_ID)) {
            console.log('Bonding curve has incorrect owner, not a pump token');
            TokenTypeCache.getInstance().setTokenType(addressStr, 'regular');
            return { isPump: false, hasMigrated: false };
        }

        // Check the migration status from the bonding curve data
        try {
            const bondingCurveData = await readBondingCurveAccount(connection, bondingCurvePk);

            if (bondingCurveData.completed) {
                console.log('Token has migrated from pump.fun');
                TokenTypeCache.getInstance().setTokenType(addressStr, 'migratedPump');
                return { isPump: false, hasMigrated: true };
            }

            // Additional validation of bonding curve state
            if (new BN(bondingCurveData.virtual_token_reserves).lten(0) || 
                new BN(bondingCurveData.virtual_sol_reserves).lten(0)) {
                console.log('Invalid bonding curve state, not an active pump token');
                TokenTypeCache.getInstance().setTokenType(addressStr, 'regular');
                return { isPump: false, hasMigrated: false };
            }

            // Token has valid bonding curve and hasn't migrated
            console.log('Active pump.fun token detected');
            return { isPump: true, hasMigrated: false };

        } catch (error) {
            console.log('Error reading bonding curve data:', error);
            // If we can't read the account data properly, it's not a valid pump token
            TokenTypeCache.getInstance().setTokenType(addressStr, 'regular');
            return { isPump: false, hasMigrated: false };
        }

    } catch (error) {
        console.error('Error in isPumpFunToken:', error);
        // In case of any errors, assume it's not a pump token for safety
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

    return new TransactionInstruction({
        programId: PUMP_FUN_PROGRAM_ID,
        keys,
        data
    });

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

    // Original working key order
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

export function calculateCurrentPrice(coinData: any): number {
    const virtualTokenReserves = new BN(coinData.virtual_token_reserves);
    const virtualSolReserves = new BN(coinData.virtual_sol_reserves);
    
    // Preserve more precision by doing string conversion and direct division
    const reserves_ratio = Number(virtualSolReserves.toString()) / Number(virtualTokenReserves.toString());
    return reserves_ratio / 1000; // Dividing by 1000 as required but maintaining precision
}

function formatError(error: any): Error {
    const message = error.message || String(error);
    
    if (message.includes("No liquidity pool found")) {
        return new Error("No liquidity pool exists for this token pair");
    }
    if (message.includes("insufficient funds")) {
        return new Error("Insufficient funds for swap");
    }
    if (message.includes("exceeds desired slippage limit")) {
        return new Error("Price impact too high. Try increasing slippage tolerance or reducing amount");
    }
    if (message.includes("0x1")) {
        return new Error("Transaction failed - check token contract and pool status");
    }
    if (message.includes("TooLittleSolReceived")) {
        return new Error("Price impact too high. Try reducing the amount or increasing slippage tolerance");
    }
    if (message.includes("BondingCurveComplete")) {
        return new Error("This token has already migrated to Raydium");
    }
    if (message.includes("NoTokenBalance")) {
        return new Error("No tokens found in your account");
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
    if (amountInSol <= 0) throw new Error("Amount must be greater than 0");
    
    console.log('\nOriginal swap parameters:', {
        amountInSol,
        slippageTolerance,
        outputToken: outputToken.toString()
    });
    
    let attempts = 0;
    const MAX_RETRY = 2;
    
    while (attempts < MAX_RETRY) {
        try {
            // Derive PDAs first
            const bondingCurvePk = deriveBondingCurvePda(outputToken);
            const associatedBondingCurvePk = await deriveAssociatedBondingCurvePda(outputToken);
            const userTokenAccount = await getAssociatedTokenAddress(outputToken, wallet.publicKey);

            console.log('PDAs:', {
                bondingCurve: bondingCurvePk.toString(),
                associatedBondingCurve: associatedBondingCurvePk.toString(),
                userTokenAccount: userTokenAccount.toString()
            });

            // Get settings first to determine if we need to fetch priority fee
            const settings = SettingsManager.getInstance().getSettings();

            const fetchStartTime = Date.now();
            
            // Parallelize initial data fetching
            const [
                bondingCurveData,
                preTokenAccount,
                tokenAccountInfo,
                preBalance,
                { blockhash, lastValidBlockHeight }
            ] = await Promise.all([
                (async () => {
                    const start = Date.now();
                    const result = await readBondingCurveAccount(connection, bondingCurvePk);
                    console.log(`Bonding curve data fetch took: ${Date.now() - start}ms`);
                    return result;
                })(),
                (async () => {
                    const start = Date.now();
                    const result = await connection.getParsedTokenAccountsByOwner(wallet.publicKey, { mint: outputToken });
                    console.log(`Pre-token account fetch took: ${Date.now() - start}ms`);
                    return result;
                })(),
                (async () => {
                    const start = Date.now();
                    const result = await connection.getAccountInfo(userTokenAccount, "processed");
                    console.log(`Token account info fetch took: ${Date.now() - start}ms`);
                    return result;
                })(),
                (async () => {
                    const start = Date.now();
                    const result = await connection.getBalance(wallet.publicKey, "processed");
                    console.log(`Pre-balance fetch took: ${Date.now() - start}ms`);
                    return result;
                })(),
                (async () => {
                    const start = Date.now();
                    const result = await BlockhashManager.getInstance().getBlockhash();
                    console.log(`Blockhash fetch took: ${Date.now() - start}ms`);
                    return result;
                })()
            ]);
            console.log(`Total parallel fetch operations took: ${Date.now() - fetchStartTime}ms`);

            console.log('Bonding curve data:', {
                virtualTokenReserves: bondingCurveData.virtual_token_reserves,
                virtualSolReserves: bondingCurveData.virtual_sol_reserves,
                realTokenReserves: bondingCurveData.real_token_reserves,
                realSolReserves: bondingCurveData.real_sol_reserves,
            });

            // Build coinData from bonding curve data
            const coinData: CoinData = {
                bonding_curve: bondingCurvePk.toBase58(),
                associated_bonding_curve: associatedBondingCurvePk.toBase58(),
                virtual_token_reserves: bondingCurveData.virtual_token_reserves,
                virtual_sol_reserves: bondingCurveData.virtual_sol_reserves,
                completed: bondingCurveData.completed
            };

            validateBondingCurveState(coinData);

            // Get pre-swap token balance for later comparison
            const preTokenBalance = preTokenAccount.value[0]?.account.data.parsed.info.tokenAmount.amount || '0';

            // Handle priority fee based on settings
            const priorityFeeStartTime = Date.now();
            let priorityFeeEstimate: number;

            if (settings.fees.useAutomaticPriorityFee) {
                try {
                    const priorityFeeResponse = await fetch(connection.rpcEndpoint, {
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

                    if (priorityFeeResponse.ok) {
                        const priorityFeeData = await priorityFeeResponse.json();
                        priorityFeeEstimate = priorityFeeData?.result?.priorityFeeEstimate || 100000;
                        console.log(`Using automatic priority fee: ${priorityFeeEstimate} microlamports`);
                    } else {
                        priorityFeeEstimate = 100000;
                        console.log('Using default priority fee due to fetch error');
                    }
                } catch (error) {
                    priorityFeeEstimate = 100000;
                    console.log('Using default priority fee due to error:', error);
                }
            } else {
                priorityFeeEstimate = settings.fees.fixedPriorityFee || 100000;
                console.log(`Using fixed priority fee: ${priorityFeeEstimate} microlamports`);
            }
            console.log(`Priority fee processing took: ${Date.now() - priorityFeeStartTime}ms`);

            const amountInLamports = Math.floor(amountInSol * LAMPORTS_PER_SOL);
            const amountInBN = new BN(amountInLamports.toString());
            
            console.log('Amount conversion:', {
                originalSol: amountInSol,
                lamports: amountInLamports,
                bnAmount: amountInBN.toString(),
                verifySOL: amountInLamports / LAMPORTS_PER_SOL
            });
            
            // Calculate expected output using the fetched data
            
            const expectedOutput = calculateExpectedOutput(amountInBN, coinData);
            const maxSolCost = amountInBN.muln(Math.floor((1 + slippageTolerance) * 1000)).divn(1000);

            console.log('Swap calculations:', {
                amountInBN: amountInBN.toString(),
                amountInSOL: amountInBN.toNumber() / LAMPORTS_PER_SOL,
                expectedOutput: expectedOutput.toString(),
                maxSolCost: maxSolCost.toString(),
                maxSolCostSOL: maxSolCost.toNumber() / LAMPORTS_PER_SOL,
                slippageMultiplier: (1 + slippageTolerance)
            });

            console.log('\nReserves from bonding curve:', {
                rawTokenReserves: bondingCurveData.virtual_token_reserves,
                rawSolReserves: bondingCurveData.virtual_sol_reserves,
                parsedTokenReserves: new BN(bondingCurveData.virtual_token_reserves).toString(),
                parsedSolReserves: new BN(bondingCurveData.virtual_sol_reserves).toString()
            });
            
            console.log('Coin data being used:', {
                bondingCurve: coinData.bonding_curve,
                virtualTokenReserves: coinData.virtual_token_reserves,
                virtualSolReserves: coinData.virtual_sol_reserves,
                format: 'These should match the bonding curve data above'
            });
            
            // After calculating expected output:
            console.log('\nCalculated swap parameters:', {
                inputAmount: amountInBN.toString(),
                inputAmountSOL: amountInBN.toNumber() / LAMPORTS_PER_SOL,
                expectedOutput: expectedOutput.toString(),
                expectedOutputHuman: expectedOutput.toNumber() / Math.pow(10, 6),
                maxSolCost: maxSolCost.toString(),
                maxSolCostSOL: maxSolCost.toNumber() / LAMPORTS_PER_SOL
            });

            // Build instructions
            const instructionBuildStartTime = Date.now();
            const transactionInstructions: TransactionInstruction[] = [];

            // Create token account if needed
            if (!tokenAccountInfo) {
                console.log('Creating new token account');
                transactionInstructions.push(
                    createAssociatedTokenAccountInstruction(
                        wallet.publicKey,
                        userTokenAccount,
                        wallet.publicKey,
                        outputToken
                    )
                );
            }

            // Add buy instruction
            transactionInstructions.push(
                await buildPumpBuyInstruction(
                    wallet.publicKey,
                    userTokenAccount,
                    outputToken,
                    coinData,
                    expectedOutput,
                    maxSolCost
                )
            );
            console.log(`Instruction building took: ${Date.now() - instructionBuildStartTime}ms`);

            const computeUnits = Math.min(200_000 * transactionInstructions.length, 1_400_000);
            console.log(`Setting compute units to: ${computeUnits}`);
            
            const instructions: TransactionInstruction[] = [
                ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnits }),
                ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFeeEstimate })
            ];

            // Time Jito tip preparation
            const jitoStartTime = Date.now();
            const jitoTip = await prepareJitoTip(
                priorityFeeEstimate,
                wallet.publicKey,
                false  // silent mode
            );
            console.log(`Jito tip preparation took: ${Date.now() - jitoStartTime}ms`);
            
            instructions.push(jitoTip);
            instructions.push(...transactionInstructions);

            const preSlot = await connection.getSlot("processed");
            console.log(`Sending transaction in slot: ${preSlot}`);

            console.log('Transaction preparation:', {
                totalInstructions: instructions.length,
                computeUnits,
                priorityFee: priorityFeeEstimate,
                wallet: wallet.publicKey.toString()
            });

            const messageV0 = new TransactionMessage({
                payerKey: wallet.publicKey,
                recentBlockhash: blockhash,
                instructions
            }).compileToV0Message();

            const transaction = new VersionedTransaction(messageV0);
            transaction.sign([wallet]);

            const startTime = Date.now();
            const signature = await sendJitoTransaction(transaction, { skipPreflight: true });

            // Time confirmation wait
            const confirmStartTime = Date.now();
            await connection.confirmTransaction({
                signature,
                blockhash,
                lastValidBlockHeight
            }, "processed");
            const confirmedSlot = await connection.getSlot("confirmed");
            const confirmTime = Date.now() - confirmStartTime;
            const endTime = Date.now();
            console.log(`Transaction confirmation took: ${confirmTime}ms`);

            // Print immediate confirmation
            console.log('\nTransaction confirmed! Fetching swap details...');
            console.log(`Transaction signature: ${signature}`);
            console.log(`Explorer link: https://solscan.io/tx/${signature}\n`);

            // Metrics collection after confirmation
            try {
                // Add slight delay to ensure blockchain state is updated
                await new Promise(resolve => setTimeout(resolve, 1000));
                
                const metricsStartTime = Date.now();
                // Parallelize metrics data fetching
                const [postTokenAccount, postBondingCurveData] = await Promise.all([
                    connection.getParsedTokenAccountsByOwner(wallet.publicKey, { mint: outputToken }),
                    readBondingCurveAccount(connection, bondingCurvePk)
                ]);
                console.log(`Metrics data fetching took: ${Date.now() - metricsStartTime}ms`);

                const postTokenBalance = postTokenAccount.value[0]?.account.data.parsed.info.tokenAmount.amount || '0';
                const tokensReceived = (Number(postTokenBalance) - Number(preTokenBalance)) / Math.pow(10, 6);

                // Construct post-swap coinData for price calculation
                const postCoinData: CoinData = {
                    bonding_curve: bondingCurvePk.toBase58(),
                    associated_bonding_curve: associatedBondingCurvePk.toBase58(),
                    virtual_token_reserves: postBondingCurveData.virtual_token_reserves,
                    virtual_sol_reserves: postBondingCurveData.virtual_sol_reserves,
                    completed: postBondingCurveData.completed
                };

                const postSwapPrice = calculateCurrentPrice(postCoinData);
                const marketCapInSol = Number(postBondingCurveData.virtual_sol_reserves) / LAMPORTS_PER_SOL;

                // Add position to tracker
                const portfolioStartTime = Date.now();
                const tracker = PortfolioTracker.getInstance();
                await tracker.addPosition(
                    outputToken.toString(),
                    amountInSol,
                    tokensReceived,
                    signature,
                    {
                        entryPriceOverride: postSwapPrice,
                        isPumpToken: true
                    }
                );
                console.log(`Portfolio tracking update took: ${Date.now() - portfolioStartTime}ms`);

                // Print final details
                console.log('\nSwap Details:', {
                    marketCap: `${marketCapInSol.toFixed(2)} SOL`,
                    entryPrice: postSwapPrice.toExponential(9),
                    tokensReceived: tokensReceived.toLocaleString(),
                    transactionTime: `${(endTime - startTime) / 1000} seconds`,
                    sentSlot: preSlot,
                    confirmedSlot,
                    slotsTraversed: confirmedSlot - preSlot
                });

            } catch (err) {
                console.error('Error recording position:', err);
                console.log('Note: Swap was successful but failed to record metrics');
            }

            return signature;

        } catch (error: any) {
            console.error('\nAttempt failed:', {
                attempt: attempts + 1,
                maxRetries: MAX_RETRY,
                error: error.message
            });

            if ((error.message?.includes("6002") || 
                 error.message?.includes("Too much SOL required")) && 
                attempts < MAX_RETRY - 1) {
                attempts++;
                console.log(`Retrying swap with fresh data (attempt ${attempts + 1}/${MAX_RETRY})...`);
                await new Promise(resolve => setTimeout(resolve, 1000));
                continue;
            }
            throw formatError(error);
        }
    }

    throw new Error("Max retry attempts reached");
}

export async function swapPumpTokenToSol(
    connection: Connection,
    wallet: Keypair,
    inputToken: PublicKey,
    percentageToSell: number,
    slippageTolerance: number = 0.2
): Promise<string> {
    if (percentageToSell <= 0 || percentageToSell > 100) {
        throw new Error("Percentage must be between 0 and 100");
    }

    console.log(`\nInitiating sell for ${percentageToSell}% of pump.fun tokens...`);
    
    let attempts = 0;
    const MAX_RETRY = 2;
    
    while (attempts < MAX_RETRY) {
        try {
            // Derive PDAs first
            const bondingCurvePk = deriveBondingCurvePda(inputToken);
            const associatedBondingCurvePk = await deriveAssociatedBondingCurvePda(inputToken);
            const userTokenAccount = await getAssociatedTokenAddress(inputToken, wallet.publicKey);

            // Get settings first to determine if we need to fetch priority fee
            const settings = SettingsManager.getInstance().getSettings();

            const fetchStartTime = Date.now();
            
            // Parallelize all initial data fetching
            const [
                bondingCurveData,
                { blockhash, lastValidBlockHeight },
                priorityFeeResponse,
                tokenAccountInfo,
                preBalance
            ] = await Promise.all([
                (async () => {
                    const start = Date.now();
                    const result = await readBondingCurveAccount(connection, bondingCurvePk);
                    console.log(`Bonding curve data fetch took: ${Date.now() - start}ms`);
                    return result;
                })(),
                (async () => {
                    const start = Date.now();
                    const result = await BlockhashManager.getInstance().getBlockhash();
                    console.log(`Blockhash fetch took: ${Date.now() - start}ms`);
                    return result;
                })(),
                fetch(connection.rpcEndpoint, {
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
                }),
                (async () => {
                    const start = Date.now();
                    const result = await getTokenAccount(connection, userTokenAccount);
                    console.log(`Token account info fetch took: ${Date.now() - start}ms`);
                    return result;
                })(),
                (async () => {
                    const start = Date.now();
                    const result = await connection.getBalance(wallet.publicKey, "processed");
                    console.log(`Pre-balance fetch took: ${Date.now() - start}ms`);
                    return result;
                })()
            ]);
            console.log(`Total parallel fetch operations took: ${Date.now() - fetchStartTime}ms`);

            // Build coinData from bonding curve data
            const coinData: CoinData = {
                bonding_curve: bondingCurvePk.toBase58(),
                associated_bonding_curve: associatedBondingCurvePk.toBase58(),
                virtual_token_reserves: bondingCurveData.virtual_token_reserves,
                virtual_sol_reserves: bondingCurveData.virtual_sol_reserves,
                completed: bondingCurveData.completed
            };

            validateBondingCurveState(coinData);

            if (!tokenAccountInfo) {
                throw new Error("No token account found or insufficient balance");
            }

            const tokenBalance = Number(tokenAccountInfo.amount);
            const amountToSell = Math.floor(tokenBalance * (percentageToSell / 100));
            console.log(`Token balance: ${tokenBalance}, Amount to sell: ${amountToSell}`);
            
            if (amountToSell <= 0) {
                throw new Error("Calculated sell amount is too small");
            }

            // Start calculation timing
            const calculationStartTime = Date.now();
            const amountToSellBN = new BN(amountToSell.toString());
            const expectedSolOutput = calculateExpectedSolOutput(amountToSellBN, coinData);
            const minSolOutput = expectedSolOutput.muln(Math.floor((1 - slippageTolerance) * 1000)).divn(1000);
            console.log(`Sell calculations took: ${Date.now() - calculationStartTime}ms`);

            console.log('\nSell Calculations:');
            console.log(`Amount to sell: ${amountToSell}`);
            console.log(`Expected SOL output: ${expectedSolOutput.toNumber() / LAMPORTS_PER_SOL} SOL`);
            console.log(`Minimum SOL output: ${minSolOutput.toNumber() / LAMPORTS_PER_SOL} SOL`);
            console.log(`Slippage tolerance: ${slippageTolerance * 100}%`);

            // Handle priority fee based on settings
            const priorityFeeStartTime = Date.now();
            let priorityFeeEstimate: number;

            if (settings.fees.useAutomaticPriorityFee) {
                priorityFeeEstimate = 100000; // Default value
                if (priorityFeeResponse.ok) {
                    try {
                        const priorityFeeData = await priorityFeeResponse.json();
                        if (priorityFeeData?.result?.priorityFeeEstimate) {
                            priorityFeeEstimate = priorityFeeData.result.priorityFeeEstimate;
                            console.log(`Using automatic priority fee: ${priorityFeeEstimate} microlamports`);
                        }
                    } catch (error) {
                        console.log('Using default priority fee due to error:', error);
                    }
                }
            } else {
                priorityFeeEstimate = settings.fees.fixedPriorityFee || 100000;
                console.log(`Using fixed priority fee: ${priorityFeeEstimate} microlamports`);
            }
            console.log(`Priority fee processing took: ${Date.now() - priorityFeeStartTime}ms`);

            // Build instructions
            const instructionBuildStartTime = Date.now();
            const transactionInstructions: TransactionInstruction[] = [];

            // Add sell instruction
            transactionInstructions.push(
                await buildPumpSellInstruction(
                    wallet.publicKey,
                    userTokenAccount,
                    inputToken,
                    coinData,
                    amountToSellBN,
                    minSolOutput
                )
            );
            console.log(`Instruction building took: ${Date.now() - instructionBuildStartTime}ms`);

            const computeUnits = Math.min(200_000 * transactionInstructions.length, 1_400_000);
            console.log(`Setting compute units to: ${computeUnits}`);
            
            const instructions: TransactionInstruction[] = [
                ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnits }),
                ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFeeEstimate })
            ];

            // Time Jito tip preparation
            const jitoStartTime = Date.now();
            const jitoTip = await prepareJitoTip(
                priorityFeeEstimate,
                wallet.publicKey,
                false  // silent mode
            );
            console.log(`Jito tip preparation took: ${Date.now() - jitoStartTime}ms`);
            
            instructions.push(jitoTip);
            instructions.push(...transactionInstructions);

            const preSlot = await connection.getSlot("processed");
            console.log(`Sending transaction in slot: ${preSlot}`);

            const messageV0 = new TransactionMessage({
                payerKey: wallet.publicKey,
                recentBlockhash: blockhash,
                instructions
            }).compileToV0Message();

            const transaction = new VersionedTransaction(messageV0);
            transaction.sign([wallet]);

            const startTime = Date.now();
            const signature = await sendJitoTransaction(transaction, { skipPreflight: true });

            // Time confirmation wait
            const confirmStartTime = Date.now();
            await connection.confirmTransaction({
                signature,
                blockhash,
                lastValidBlockHeight
            }, "processed");
            const confirmedSlot = await connection.getSlot("confirmed");
            const confirmTime = Date.now() - confirmStartTime;
            const endTime = Date.now();
            console.log(`Transaction confirmation took: ${confirmTime}ms`);

            // Print immediate confirmation
            console.log('\nTransaction confirmed! Fetching swap details...');
            console.log(`Transaction signature: ${signature}`);
            console.log(`Explorer link: https://solscan.io/tx/${signature}\n`);

            // Calculate actual SOL received and metrics
            try {
                // Add slight delay to ensure blockchain state is updated
                await new Promise(resolve => setTimeout(resolve, 1000));
                
                const metricsStartTime = Date.now();
                const [postBalance, postBondingCurveData] = await Promise.all([
                    connection.getBalance(wallet.publicKey),
                    readBondingCurveAccount(connection, bondingCurvePk)
                ]);
                console.log(`Metrics data fetching took: ${Date.now() - metricsStartTime}ms`);
                
                const solReceived = (postBalance - preBalance) / LAMPORTS_PER_SOL;
                const amountToSellHuman = amountToSell / Math.pow(10, 6);

                // Calculate current price and market cap from updated bonding curve data
                const postCoinData: CoinData = {
                    bonding_curve: bondingCurvePk.toBase58(),
                    associated_bonding_curve: associatedBondingCurvePk.toBase58(),
                    virtual_token_reserves: postBondingCurveData.virtual_token_reserves,
                    virtual_sol_reserves: postBondingCurveData.virtual_sol_reserves,
                    completed: postBondingCurveData.completed
                };

                const exitPrice = calculateCurrentPrice(postCoinData);
                const marketCapInSol = Number(postBondingCurveData.virtual_sol_reserves) / LAMPORTS_PER_SOL;

                // Add position to tracker
                const portfolioStartTime = Date.now();
                const tracker = PortfolioTracker.getInstance();
                await tracker.addPosition(
                    inputToken.toString(),
                    -solReceived,
                    -amountToSellHuman,
                    signature,
                    {
                        entryPriceOverride: exitPrice,
                        isPumpToken: true
                    }
                );
                console.log(`Portfolio tracking update took: ${Date.now() - portfolioStartTime}ms`);

                console.log('\nTransaction Details:');
                console.log(`Market Cap at Exit: ${marketCapInSol.toFixed(2)} SOL`);
                console.log(`Exit Price: ${exitPrice.toExponential(9)} SOL`);
                console.log(`SOL Received: ${solReceived.toFixed(4)} SOL`);
                console.log(`Tokens Sold: ${amountToSell.toLocaleString()}`);
                console.log(`Expected SOL: ${expectedSolOutput.toNumber() / LAMPORTS_PER_SOL} SOL`);
                console.log(`Maximum Price Impact: ${(slippageTolerance * 100).toFixed(1)}%`);
                console.log(`Total transaction time: ${(endTime - startTime) / 1000} seconds`);
                console.log(`Transaction sent in slot: ${preSlot}`);
                console.log(`Transaction confirmed in slot: ${confirmedSlot}`);
                console.log(`Slots traversed: ${confirmedSlot - preSlot}`);

            } catch (err) {
                console.log('Note: Failed to record trade metrics, but swap was successful');
                console.log(`Transaction signature: ${signature}`);
                console.log(`Explorer link: https://solscan.io/tx/${signature}`);
            }

            return signature;

        } catch (error: any) {
            if ((error.message?.includes("6002") || 
                 error.message?.includes("Too much SOL required")) && 
                attempts < MAX_RETRY - 1) {
                attempts++;
                console.log(`Retrying swap with fresh data (attempt ${attempts + 1}/${MAX_RETRY})...`);
                await new Promise(resolve => setTimeout(resolve, 1000));
                continue;
            }
            throw formatError(error);
        }
    }

    throw new Error("Max retry attempts reached");
}