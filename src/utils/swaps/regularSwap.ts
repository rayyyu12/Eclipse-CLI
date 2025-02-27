//new regularSwap.ts
import { Connection, Keypair, TransactionMessage, VersionedTransaction, ComputeBudgetProgram, PublicKey, TransactionInstruction, SystemProgram, LAMPORTS_PER_SOL, SYSVAR_RENT_PUBKEY, ParsedAccountData } from "@solana/web3.js";
import { getAssociatedTokenAddress, Account as TokenAccount, getAccount as getTokenAccount, createAssociatedTokenAccountIdempotentInstruction, createAssociatedTokenAccountInstruction, createCloseAccountInstruction, createSyncNativeInstruction, NATIVE_MINT, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import BN from 'bn.js';
import { PersistentPoolCache } from '../pools/persistentPoolCache';
import { discoverPool } from '../pools/poolDiscovery';
import { buildSwapInstruction } from './swapBuilder';
import { sendJitoTransaction, prepareJitoTip } from '../fees/jito';
import { createInterface } from 'readline';  // Change this line
import { promisify } from 'util';
import { isPumpFunToken, swapPumpTokenToSol } from "./pumpSwap";
import { PoolAccounts } from "../../types";
import { TokenTypeCache } from "../pools/tokenTypeCache";
import { PortfolioTracker } from '../positions/portfolioTracker';
import { SettingsManager } from "../../cli/utils/settingsManager";
import { CredentialsManager } from "../../cli/utils/credentialsManager";
import { BlockhashManager } from "./blockhashManager";

const MAX_RETRIES = 3;
const RETRY_DELAY = 1000; // 1 second
const MAX_PRICE_IMPACT = 0.1; // 10%
const POOL_FEE_BUFFER = 0.003; // 0.3%
const DEFAULT_PRIORITY_FEE = 100_000;

const STATIC_COMPUTE_BUDGET_IX = ComputeBudgetProgram.setComputeUnitPrice({
    microLamports: 100000 // Default value, can be overridden if needed
});

function calculateOutputAmount(
    amountIn: number,
    poolCoinBalance: number,
    poolPcBalance: number,
    tokenDecimals: number
): number {
    // Adjust for decimal difference between token (6) and SOL (9)
    const decimalAdjustment = Math.pow(10, 9 - tokenDecimals); // Should still be 1000 for 6 decimal token

    // Calculate output using pool ratio with decimal adjustment
    const rawExpectedOutput = (amountIn * poolPcBalance) / (poolCoinBalance * decimalAdjustment);
    
    // Apply the additional shift that was in the original code
    const expectedOutput = Math.floor(rawExpectedOutput * Math.pow(10, -4));
    
    return expectedOutput;
}

export async function swapSolToToken(
    connection: Connection,
    wallet: Keypair,
    outputToken: PublicKey,
    amountIn: number,
    slippageTolerance: number = 0.5
): Promise<string> {
    if (amountIn <= 0) throw new Error("Amount must be greater than 0");

    const poolCache = PersistentPoolCache.getInstance();
    const [mint1, mint2] = [NATIVE_MINT.toString(), outputToken.toString()].sort();
    const poolId = `${mint1}/${mint2}`;

    const poolStartTime = Date.now();
    const poolCachePromise = (async () => {
        let poolAccounts = poolCache.get(poolId);
        if (!poolAccounts) {
            poolAccounts = await discoverPool(connection, NATIVE_MINT, outputToken, true);
            if (poolAccounts) poolCache.set(poolId, poolAccounts);
        }
        return poolAccounts;
    })();

    const fetchStartTime = Date.now();
    
    // Get settings first to determine if we need to fetch priority fee
    const settings = SettingsManager.getInstance().getSettings();
    
    // Fetch initial data in parallel
    const [
        userWSOLAccount,
        userDestinationTokenAccount,
        tokenMintInfo,
        priorityFeeResponse,
        poolAccounts
    ] = await Promise.all([
        (async () => {
            const start = Date.now();
            const result = await getAssociatedTokenAddress(NATIVE_MINT, wallet.publicKey, false);
            return result;
        })(),
        (async () => {
            const start = Date.now();
            const result = await getAssociatedTokenAddress(outputToken, wallet.publicKey, false);
            return result;
        })(),
        (async () => {
            const start = Date.now();
            const result = await connection.getParsedAccountInfo(outputToken, "processed");
            return result;
        })(),
        // Only fetch priority fee if automatic mode is enabled
        (async () => {
            if (settings.fees.useAutomaticPriorityFee) {
                const start = Date.now();
                const result = await fetch(connection.rpcEndpoint, {
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
                return result;
            }
            return null;
        })(),
        poolCachePromise
    ]);

    // Get cached blockhash
    const blockhashStartTime = Date.now();
    const { blockhash, lastValidBlockHeight } = await BlockhashManager.getInstance().getBlockhash();

    if (!poolAccounts) throw new Error("No liquidity pool found");
    if (!tokenMintInfo.value) {
        throw new Error("Invalid token mint address");
    }

    const tokenDecimals = (tokenMintInfo.value?.data as any)?.parsed?.info?.decimals || 9;

    // Time pre-swap balance check
    const preSwapStartTime = Date.now();
    const preSwapAccount = await getTokenAccount(connection, userDestinationTokenAccount)
        .catch(() => null);
    const preSwapBalance = preSwapAccount ? Number(preSwapAccount.amount) : 0;

    // Handle priority fee based on settings
    let priorityFeeEstimate: number;
    const priorityFeeStartTime = Date.now();

    if (settings.fees.useAutomaticPriorityFee) {
        priorityFeeEstimate = DEFAULT_PRIORITY_FEE; // Default value
        if (priorityFeeResponse && priorityFeeResponse.ok) {
            try {
                const priorityFeeData = await priorityFeeResponse.json();
                if (priorityFeeData?.result?.priorityFeeEstimate) {
                    priorityFeeEstimate = priorityFeeData.result.priorityFeeEstimate;
                    console.log(`Using automatic priority fee: ${priorityFeeEstimate} microLamports/cu`);
                }
            } catch (error) {
                console.log(`Using default priority fee (${DEFAULT_PRIORITY_FEE} microLamports/cu) due to error:`, error);
            }
        }
    } else {
        priorityFeeEstimate = settings.fees.fixedPriorityFee || DEFAULT_PRIORITY_FEE;
    }

    // Build transaction instructions
    const transactionInstructions: TransactionInstruction[] = [];

    // Use idempotent ATA creation instructions - no need to check existence
    transactionInstructions.push(
        createAssociatedTokenAccountIdempotentInstruction(
            wallet.publicKey,
            userDestinationTokenAccount,
            wallet.publicKey,
            outputToken
        ),
        createAssociatedTokenAccountIdempotentInstruction(
            wallet.publicKey,
            userWSOLAccount,
            wallet.publicKey,
            NATIVE_MINT
        )
    );

    // Add core swap instructions
    transactionInstructions.push(
        SystemProgram.transfer({
            fromPubkey: wallet.publicKey,
            toPubkey: userWSOLAccount,
            lamports: amountIn
        })
    );

    transactionInstructions.push(createSyncNativeInstruction(userWSOLAccount));

    const amountInBN = new BN(amountIn.toString());
    const minAmountOutBN = amountInBN.mul(new BN(1000 - (slippageTolerance * 1000))).div(new BN(1000));

    // Time swap instruction building
    const swapInstructionStartTime = Date.now();
    transactionInstructions.push(
        await buildSwapInstruction(
            wallet.publicKey,
            userWSOLAccount,
            userDestinationTokenAccount,
            poolAccounts,
            amountInBN,
            minAmountOutBN,
            true
        )
    );

    // Calculate compute units and prepare final instructions
    const computeUnits = Math.min(200_000 * transactionInstructions.length, 1_400_000);
    const instructions: TransactionInstruction[] = [];
    
    instructions.push(
        ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnits }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFeeEstimate })
    );

    // Time Jito tip preparation
    const jitoStartTime = Date.now();
    const jitoTip = await prepareJitoTip(
        priorityFeeEstimate,
        wallet.publicKey,
        false // silent mode
    );
    
    instructions.push(jitoTip);
    instructions.push(...transactionInstructions);

    const preSlot = await connection.getSlot("processed");

    // Build and send transaction
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
    await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight });
    const confirmedSlot = await connection.getSlot("confirmed");
    const confirmTime = Date.now() - confirmStartTime;
    const endTime = Date.now();

    // Time post-swap operations
    const postSwapStartTime = Date.now();
    const postSwapAccount = await getTokenAccount(connection, userDestinationTokenAccount);
    const postSwapBalance = Number(postSwapAccount.amount);
    const tokensReceived = (postSwapBalance - preSwapBalance) / Math.pow(10, tokenDecimals);

    // Calculate actual entry price
    const actualEntryPrice = amountIn / LAMPORTS_PER_SOL / tokensReceived;

    // Time portfolio update
    const portfolioStartTime = Date.now();
    const tracker = PortfolioTracker.getInstance();
    await tracker.addPosition(
        outputToken.toString(),
        amountIn / LAMPORTS_PER_SOL,
        tokensReceived,
        signature,
        {
            entryPriceOverride: actualEntryPrice,
            isPumpToken: false
        }
    );

    // Log transaction details

    return signature;
}

export async function swapTokenToSol(
    connection: Connection,
    wallet: Keypair,
    inputToken: PublicKey,
    percentageToSell: number,
    slippageTolerance: number = 0.2
): Promise<string> {
    if (percentageToSell <= 0 || percentageToSell > 100) {
        throw new Error("Percentage must be between 0 and 100");
    }

    const poolCache = PersistentPoolCache.getInstance();
    const [mint1, mint2] = [NATIVE_MINT.toString(), inputToken.toString()].sort();
    const poolId = `${mint1}/${mint2}`;
    
    const poolCachePromise = (async () => {
        let poolAccounts = poolCache.get(poolId);
        if (!poolAccounts) {
            poolAccounts = await discoverPool(connection, NATIVE_MINT, inputToken, true);
            if (poolAccounts) poolCache.set(poolId, poolAccounts);
        }
        return poolAccounts;
    })();

    const settings = SettingsManager.getInstance().getSettings();

    const [
        tokenMint,
        userTokenAccount,
        userWSOLAccount,
        walletBalance,
        poolAccounts,
        { blockhash, lastValidBlockHeight }
    ] = await Promise.all([
        connection.getParsedAccountInfo(inputToken, "processed"),
        getAssociatedTokenAddress(inputToken, wallet.publicKey, false),
        getAssociatedTokenAddress(NATIVE_MINT, wallet.publicKey, false),
        connection.getBalance(wallet.publicKey, "processed"),
        poolCachePromise,
        BlockhashManager.getInstance().getBlockhash()
    ]);

    if (!poolAccounts) {
        throw new Error("No liquidity pool found for this token");
    }

    const tokenDecimals = (tokenMint.value?.data as any)?.parsed?.info?.decimals || 9;

    const [tokenAccountInfo, wsolAccountInfo, existingWsolBalance] = await Promise.all([
        getTokenAccount(connection, userTokenAccount),
        connection.getAccountInfo(userWSOLAccount, "processed"),
        (async () => {
            try {
                const balance = await connection.getTokenAccountBalance(userWSOLAccount);
                return balance.value.uiAmount;
            } catch {
                return null;
            }
        })()
    ]);

    if (!tokenAccountInfo) {
        throw new Error("No token account found");
    }

    const tokenBalance = Number(tokenAccountInfo.amount);
    const amountToSell = Math.floor(tokenBalance * (percentageToSell / 100));

    if (amountToSell <= 0) {
        throw new Error("Calculated sell amount is too small");
    }

    const [poolCoinAccount, poolPcAccount] = await Promise.all([
        getTokenAccount(connection, poolAccounts.poolCoinTokenAccount),
        getTokenAccount(connection, poolAccounts.poolPcTokenAccount)
    ]);

    if (!poolCoinAccount || !poolPcAccount) {
        throw new Error("Failed to fetch pool token accounts");
    }

    const poolCoinBalance = Number(poolCoinAccount.amount);
    const poolPcBalance = Number(poolPcAccount.amount);

    const expectedOutput = calculateOutputAmount(
        amountToSell,
        poolCoinBalance,
        poolPcBalance,
        tokenDecimals
    );

    let priorityFeeEstimate = DEFAULT_PRIORITY_FEE;
    
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
                priorityFeeEstimate = priorityFeeData?.result?.priorityFeeEstimate || DEFAULT_PRIORITY_FEE;
            }
        } catch (error) {
            priorityFeeEstimate = DEFAULT_PRIORITY_FEE;
        }
    } else {
        priorityFeeEstimate = settings.fees.fixedPriorityFee || DEFAULT_PRIORITY_FEE;
    }

    const amountInBN = new BN(amountToSell.toString());
    const minAmountOutBN = new BN(Math.floor(expectedOutput * (1 - slippageTolerance - POOL_FEE_BUFFER)));

    const transactionInstructions: TransactionInstruction[] = [];

    transactionInstructions.push(
        createAssociatedTokenAccountIdempotentInstruction(
            wallet.publicKey,
            userWSOLAccount,
            wallet.publicKey,
            NATIVE_MINT
        )
    );

    transactionInstructions.push(
        await buildSwapInstruction(
            wallet.publicKey,
            userTokenAccount,
            userWSOLAccount,
            poolAccounts,
            amountInBN,
            minAmountOutBN,
            true
        )
    );

    if (!existingWsolBalance) {
        transactionInstructions.push(
            createCloseAccountInstruction(
                userWSOLAccount,
                wallet.publicKey,
                wallet.publicKey
            )
        );
    }

    const computeUnits = Math.min(200_000 * transactionInstructions.length, 1_400_000);
    const instructions: TransactionInstruction[] = [];
    
    instructions.push(
        ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnits }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFeeEstimate })
    );

    const jitoTip = await prepareJitoTip(
        priorityFeeEstimate,
        wallet.publicKey,
        false
    );
    
    instructions.push(jitoTip);
    instructions.push(...transactionInstructions);

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
    });

    console.log("✔ Sell successful!");
    console.log("Transaction Details:");
    console.log(`Signature: ${signature}`);
    console.log(`Explorer: https://solscan.io/tx/${signature}`);

    return signature;
}

export async function sellTokens(): Promise<void> {
    const rl = createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: false
    });

    try {
        const askQuestion = (query: string): Promise<string> => {
            return new Promise((resolve) => {
                process.stdout.write(query);
                rl.once('line', (line) => resolve(line));
            });
        };

        // Get token address from user
        const tokenAddress = await askQuestion("Enter the token address you want to sell: ");
        let tokenPublicKey: PublicKey;
        
        try {
            tokenPublicKey = new PublicKey(tokenAddress);
        } catch (err) {
            console.error("Error: Invalid token address format");
            process.exit(1);
        }

        // Get percentage from user
        const percentageStr = await askQuestion("Enter the percentage of tokens you want to sell (1-100): ");
        const percentage = parseFloat(percentageStr);
        
        if (isNaN(percentage) || percentage <= 0 || percentage > 100) {
            console.error("Error: Invalid percentage. Must be between 1 and 100");
            process.exit(1);
        }

        // Initialize connection and wallet
        // Initialize connection and wallet using CredentialsManager
        const credManager = CredentialsManager.getInstance();
        if (!credManager.hasCredentials()) {
            console.error("Error: Missing RPC URL or private key in credentials");
            console.error("Please configure them in settings first");
            process.exit(1);
        }

        const connection = credManager.getConnection();
        const wallet = credManager.getKeyPair();

        try {
            // Check token type cache first
            const tokenCache = TokenTypeCache.getInstance();
            const cachedInfo = tokenCache.getTokenType(tokenAddress);

            // Initialize variables for token type
            let isPump = false;
            let hasMigrated = false;

            if (cachedInfo) {
                if (cachedInfo.type === 'regular') {
                    isPump = false;
                    hasMigrated = false;
                } else if (cachedInfo.type === 'migratedPump') {
                    isPump = false;
                    hasMigrated = true;
                }
            } else {
                // No cache hit, need to check token type
                const tokenInfo = await isPumpFunToken(connection, tokenAddress);
                isPump = tokenInfo.isPump;
                hasMigrated = tokenInfo.hasMigrated;
            }

            if (isPump) {
                // Check for Raydium pools first for migrated tokens
                const poolCache = PersistentPoolCache.getInstance();
                const [mint1, mint2] = [NATIVE_MINT.toString(), tokenAddress].sort();
                const poolId = `${mint1}/${mint2}`;
                let hasRaydiumPool = false;

                const cachedPool = poolCache.get(poolId);
                if (cachedPool) {
                    console.log('Found cached pool information');
                    hasRaydiumPool = true;
                } else {
                    try {
                        const poolAccounts = await discoverPool(connection, NATIVE_MINT, tokenPublicKey, true);
                        if (poolAccounts) {
                            hasRaydiumPool = true;
                            poolCache.set(poolId, poolAccounts);
                            // Cache as migrated pump token
                            tokenCache.setTokenType(tokenAddress, 'migratedPump');
                        }
                    } catch (err) {
                        hasRaydiumPool = false;
                    }
                }

                if (hasRaydiumPool) {
                    console.log("Found Raydium pool for pump.fun token. Using regular swap...");
                    const signature = await swapTokenToSol(
                        connection,
                        wallet,
                        tokenPublicKey,
                        percentage,
                        0.2
                    );
                    console.log("Regular swap successful!");
                    console.log("Transaction signature:", signature);
                    console.log(`Explorer link: https://solscan.io/tx/${signature}`);
                } else {
                    console.log("No Raydium pool found. Using pump.fun sell mechanism...");
                    try {
                        const signature = await swapPumpTokenToSol(
                            connection,
                            wallet,
                            tokenPublicKey,
                            percentage,
                            0.2
                        );
                        console.log("Pump.fun swap successful!");
                        console.log("Transaction signature:", signature);
                        console.log(`Explorer link: https://solscan.io/tx/${signature}`);
                    } catch (err) {
                        const error = err as Error;
                        if (error.message.includes("BondingCurveComplete")) {
                            console.error("Error: This token has already migrated to Raydium. Please use regular swap.");
                        } else if (error.message.includes("TooLittleSolReceived")) {
                            console.error("Error: Price impact too high. Try reducing the amount or increasing slippage tolerance");
                        } else {
                            console.error("Error during pump.fun swap:", error.message);
                        }
                        process.exit(1);
                    }
                }
            } else {
                // Regular token or migrated pump token, use normal Raydium swap
                const signature = await swapTokenToSol(
                    connection,
                    wallet,
                    tokenPublicKey,
                    percentage,
                    0.2
                );
                console.log("Regular swap successful!");
                console.log("Transaction signature:", signature);
                console.log(`Explorer link: https://solscan.io/tx/${signature}`);
            }

        } catch (err) {
            const error = err as Error;
            if (error.message.includes("No liquidity pool found")) {
                console.error("Error: No liquidity pool exists for this token pair");
            } else if (error.message.includes("insufficient funds")) {
                console.error("Error: Insufficient funds for swap");
            } else if (error.message.includes("exceeds desired slippage limit")) {
                console.error("Error: Price impact too high. Try reducing the amount or increasing slippage tolerance");
            } else {
                console.error("Error performing swap:", error.message);
            }
            process.exit(1);
        }

    } catch (err) {
        const error = err as Error;
        console.error("Fatal error:", error.message);
        process.exit(1);
    } finally {
        rl.close();
    }
}