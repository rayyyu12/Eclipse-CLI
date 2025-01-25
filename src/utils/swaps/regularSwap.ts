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
    console.log('\nDetailed Swap Calculation:');
    console.log('Initial Values:');
    console.log(`Amount In: ${amountIn} (${amountIn / Math.pow(10, tokenDecimals)} tokens)`);
    console.log(`Pool Coin: ${poolCoinBalance} (${poolCoinBalance / Math.pow(10, tokenDecimals)} tokens)`);
    console.log(`Pool PC: ${poolPcBalance} (${poolPcBalance / LAMPORTS_PER_SOL} SOL)`);

    // Adjust for decimal difference between token (6) and SOL (9)
    const decimalAdjustment = Math.pow(10, 9 - tokenDecimals); // Should still be 1000 for 6 decimal token
    console.log(`\nDecimal Adjustment: ${decimalAdjustment}`);

    // Calculate output using pool ratio with decimal adjustment
    const rawExpectedOutput = (amountIn * poolPcBalance) / (poolCoinBalance * decimalAdjustment);
    console.log('\nIntermediate Calculations:');
    console.log(`Raw Expected Output (before shifting): ${rawExpectedOutput}`);
    
    // Apply the additional shift that was in the original code
    const expectedOutput = Math.floor(rawExpectedOutput * Math.pow(10, -4));
    
    console.log('\nFinal Results:');
    console.log(`1. Pool Ratio (after adjustment): ${(poolPcBalance / (poolCoinBalance * decimalAdjustment)).toFixed(8)}`);
    console.log(`2. Raw Output: ${rawExpectedOutput}`);
    console.log(`3. Additional Shift Factor: ${Math.pow(10, -4)}`);
    console.log(`4. Final Expected Output: ${expectedOutput} lamports`);
    console.log(`5. Expected Output in SOL: ${expectedOutput / LAMPORTS_PER_SOL} SOL`);
    console.log(`6. Price Impact: ${((amountIn / poolCoinBalance) * 100).toFixed(4)}%`);

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
    console.log('\nInitiating SOL to Token swap...');

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
        console.log(`Pool discovery/cache fetch took: ${Date.now() - poolStartTime}ms${poolAccounts ? ' (cache hit)' : ' (cache miss)'}`);
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
            console.log(`WSOL address computation took: ${Date.now() - start}ms`);
            return result;
        })(),
        (async () => {
            const start = Date.now();
            const result = await getAssociatedTokenAddress(outputToken, wallet.publicKey, false);
            console.log(`Destination token address computation took: ${Date.now() - start}ms`);
            return result;
        })(),
        (async () => {
            const start = Date.now();
            const result = await connection.getParsedAccountInfo(outputToken, "processed");
            console.log(`Token mint info fetch took: ${Date.now() - start}ms`);
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
                console.log(`Priority fee fetch took: ${Date.now() - start}ms`);
                return result;
            }
            return null;
        })(),
        poolCachePromise
    ]);
    console.log(`Total parallel fetch operations took: ${Date.now() - fetchStartTime}ms`);

    // Get cached blockhash
    const blockhashStartTime = Date.now();
    const { blockhash, lastValidBlockHeight } = await BlockhashManager.getInstance().getBlockhash();
    console.log(`Blockhash fetch took: ${Date.now() - blockhashStartTime}ms`);

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
    console.log(`Pre-swap balance check took: ${Date.now() - preSwapStartTime}ms`);
    console.log(`Pre-swap token balance: ${preSwapBalance / Math.pow(10, tokenDecimals)}`);

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
        console.log(`Using fixed priority fee: ${priorityFeeEstimate} microLamports/cu`);
    }
    console.log(`Priority fee processing took: ${Date.now() - priorityFeeStartTime}ms`);

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
    console.log(`Swap instruction building took: ${Date.now() - swapInstructionStartTime}ms`);

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
    console.log(`Jito tip preparation took: ${Date.now() - jitoStartTime}ms`);
    
    instructions.push(jitoTip);
    instructions.push(...transactionInstructions);

    const preSlot = await connection.getSlot("processed");
    console.log(`Sending transaction in slot: ${preSlot}`);

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
    console.log(`Transaction confirmation took: ${confirmTime}ms`);

    // Time post-swap operations
    const postSwapStartTime = Date.now();
    const postSwapAccount = await getTokenAccount(connection, userDestinationTokenAccount);
    const postSwapBalance = Number(postSwapAccount.amount);
    const tokensReceived = (postSwapBalance - preSwapBalance) / Math.pow(10, tokenDecimals);
    console.log(`Post-swap balance check took: ${Date.now() - postSwapStartTime}ms`);

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
    console.log(`Portfolio tracking update took: ${Date.now() - portfolioStartTime}ms`);

    // Log transaction details
    console.log('\nSwap Details:');
    console.log(`SOL Spent: ${amountIn / LAMPORTS_PER_SOL}`);
    console.log(`Tokens Received: ${tokensReceived}`);
    console.log(`Entry Price: ${actualEntryPrice.toFixed(9)} SOL per token`);
    console.log(`Total transaction time: ${(endTime - startTime) / 1000} seconds`);
    console.log(`Transaction sent in slot: ${preSlot}`);
    console.log(`Transaction confirmed in slot: ${confirmedSlot}`);
    console.log(`Slots traversed: ${confirmedSlot - preSlot}`);
    console.log(`Explorer link: https://solscan.io/tx/${signature}`);

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

    console.log('\n=== Starting Token to SOL Swap ===');
    console.log('Initial Parameters:');
    console.log(`Input Token: ${inputToken.toString()}`);
    console.log(`Percentage to Sell: ${percentageToSell}%`);
    console.log(`Slippage Tolerance: ${slippageTolerance}%`);

    // Start pool discovery immediately if not in cache
    const poolStartTime = Date.now();
    const poolCache = PersistentPoolCache.getInstance();
    const [mint1, mint2] = [NATIVE_MINT.toString(), inputToken.toString()].sort();
    const poolId = `${mint1}/${mint2}`;
    
    console.log('\n=== Pool Discovery ===');
    const poolCachePromise = (async () => {
        let poolAccounts = poolCache.get(poolId);
        if (!poolAccounts) {
            console.log('Cache miss - discovering pool...');
            poolAccounts = await discoverPool(connection, NATIVE_MINT, inputToken, true);
            if (poolAccounts) {
                console.log('Pool discovered and cached');
                poolCache.set(poolId, poolAccounts);
            }
        } else {
            console.log('Pool found in cache');
        }
        console.log(`Pool discovery/cache fetch took: ${Date.now() - poolStartTime}ms`);
        return poolAccounts;
    })();

    const fetchStartTime = Date.now();
    console.log('\n=== Fetching Initial Data ===');

    // Get settings first
    const settings = SettingsManager.getInstance().getSettings();

    // Parallelize initial data fetching
    const [
        tokenMint,
        userTokenAccount,
        userWSOLAccount,
        walletBalance,
        poolAccounts,
        { blockhash, lastValidBlockHeight }
    ] = await Promise.all([
        (async () => {
            const start = Date.now();
            const result = await connection.getParsedAccountInfo(inputToken, "processed");
            console.log(`Token mint info fetch took: ${Date.now() - start}ms`);
            return result;
        })(),
        (async () => {
            const start = Date.now();
            const result = await getAssociatedTokenAddress(inputToken, wallet.publicKey, false);
            console.log(`User token address computation took: ${Date.now() - start}ms`);
            return result;
        })(),
        (async () => {
            const start = Date.now();
            const result = await getAssociatedTokenAddress(NATIVE_MINT, wallet.publicKey, false);
            console.log(`WSOL address computation took: ${Date.now() - start}ms`);
            return result;
        })(),
        (async () => {
            const start = Date.now();
            const result = await connection.getBalance(wallet.publicKey, "processed");
            console.log(`Wallet balance fetch took: ${Date.now() - start}ms`);
            return result;
        })(),
        poolCachePromise,
        (async () => {
            const start = Date.now();
            const result = await BlockhashManager.getInstance().getBlockhash();
            console.log(`Blockhash fetch took: ${Date.now() - start}ms`);
            return result;
        })()
    ]);

    if (!poolAccounts) {
        throw new Error("No liquidity pool found for this token");
    }

    console.log('\n=== Token Information ===');
    const tokenDecimals = (tokenMint.value?.data as any)?.parsed?.info?.decimals || 9;
    console.log('Token Details:', {
        decimals: tokenDecimals,
        mint: inputToken.toString()
    });
    
    console.log('\n=== Account Addresses ===');
    console.log({
        userTokenAccount: userTokenAccount.toString(),
        userWSOLAccount: userWSOLAccount.toString(),
        wallet: wallet.publicKey.toString()
    });

    // Get token balance and WSOL account info in parallel
    console.log('\n=== Account Balance Checks ===');
    const accountCheckStartTime = Date.now();
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
    console.log(`Account info checks took: ${Date.now() - accountCheckStartTime}ms`);

    console.log('WSOL Account Status:', {
        exists: !!wsolAccountInfo,
        previousBalance: existingWsolBalance || 0
    });

    if (!tokenAccountInfo) {
        throw new Error("No token account found");
    }

    const tokenBalance = Number(tokenAccountInfo.amount);
    console.log('\n=== Balance Information ===');
    console.log({
        rawTokenBalance: tokenBalance,
        adjustedTokenBalance: tokenBalance / Math.pow(10, tokenDecimals),
        decimals: tokenDecimals
    });

    const amountToSell = Math.floor(tokenBalance * (percentageToSell / 100));
    console.log('\n=== Sell Amount Calculation ===');
    console.log({
        rawAmount: amountToSell,
        adjustedAmount: amountToSell / Math.pow(10, tokenDecimals),
        percentage: percentageToSell
    });

    if (amountToSell <= 0) {
        throw new Error("Calculated sell amount is too small");
    }

    // Get pool balances in parallel
    console.log('\n=== Fetching Pool Balances ===');
    const poolStartTime2 = Date.now();
    const [poolCoinAccount, poolPcAccount] = await Promise.all([
        getTokenAccount(connection, poolAccounts.poolCoinTokenAccount),
        getTokenAccount(connection, poolAccounts.poolPcTokenAccount)
    ]);
    console.log(`Pool balance fetches took: ${Date.now() - poolStartTime2}ms`);

    if (!poolCoinAccount || !poolPcAccount) {
        throw new Error("Failed to fetch pool token accounts");
    }

    const poolCoinBalance = Number(poolCoinAccount.amount);
    const poolPcBalance = Number(poolPcAccount.amount);
    
    console.log('\n=== Pool Balance Details ===');
    console.log({
        coin: {
            raw: poolCoinBalance,
            adjusted: poolCoinBalance / Math.pow(10, tokenDecimals),
            decimals: tokenDecimals,
            address: poolAccounts.poolCoinTokenAccount.toString()
        },
        pc: {
            raw: poolPcBalance,
            adjusted: poolPcBalance / LAMPORTS_PER_SOL,
            decimals: 9,
            address: poolAccounts.poolPcTokenAccount.toString()
        }
    });

    const expectedOutput = calculateOutputAmount(
        amountToSell,
        poolCoinBalance,
        poolPcBalance,
        tokenDecimals
    );

    const priceImpact = (amountToSell / poolCoinBalance) * 100;
    console.log('DEBUG: Price Impact:', priceImpact.toFixed(2) + '%');

    // Handle priority fee based on settings
    let priorityFeeEstimate: number;
    const priorityFeeStartTime = Date.now();

    if (settings.fees.useAutomaticPriorityFee) {
        priorityFeeEstimate = DEFAULT_PRIORITY_FEE; // Default value
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
                console.log(`Using automatic priority fee: ${priorityFeeEstimate} microLamports/cu`);
            } else {
                console.log(`Using default priority fee (${DEFAULT_PRIORITY_FEE} microLamports/cu) due to fetch error`);
            }
        } catch (error) {
            console.log(`Using default priority fee (${DEFAULT_PRIORITY_FEE} microLamports/cu) due to error:`, error);
        }
    } else {
        priorityFeeEstimate = settings.fees.fixedPriorityFee || DEFAULT_PRIORITY_FEE;
        console.log(`Using fixed priority fee: ${priorityFeeEstimate} microLamports/cu`);
    }
    console.log(`Priority fee processing took: ${Date.now() - priorityFeeStartTime}ms`);

    const amountInBN = new BN(amountToSell.toString());
    const minAmountOutBN = new BN(Math.floor(expectedOutput * (1 - slippageTolerance - POOL_FEE_BUFFER)));

    console.log('DEBUG: Swap Amounts:', {
        amountIn: amountToSell,
        amountInBN: amountInBN.toString(),
        minAmountOutBN: minAmountOutBN.toString(),
        slippageTolerance,
        POOL_FEE_BUFFER,
        expectedOutput,
        expectedOutputSOL: expectedOutput / LAMPORTS_PER_SOL
    });

    // Build transaction instructions with logging
    console.log('DEBUG: Building transaction instructions...');
    const transactionInstructions: TransactionInstruction[] = [];

    // Use idempotent instruction for WSOL account
    console.log('DEBUG: Adding idempotent WSOL account instruction');
    transactionInstructions.push(
        createAssociatedTokenAccountIdempotentInstruction(
            wallet.publicKey,
            userWSOLAccount,
            wallet.publicKey,
            NATIVE_MINT
        )
    );

    // Time swap instruction building
    const swapInstructionStartTime = Date.now();
    console.log('DEBUG: Building swap instruction...');
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
    console.log(`Swap instruction building took: ${Date.now() - swapInstructionStartTime}ms`);

    // Only add close instruction if there was no pre-existing WSOL balance
    if (!existingWsolBalance) {
        console.log('DEBUG: Adding WSOL close instruction (no pre-existing balance)');
        transactionInstructions.push(
            createCloseAccountInstruction(
                userWSOLAccount,
                wallet.publicKey,
                wallet.publicKey
            )
        );
    } else {
        console.log(`DEBUG: Skipping WSOL close instruction (existing balance: ${existingWsolBalance} WSOL)`);
    }

    // Calculate dynamic compute budget
    const computeUnits = Math.min(200_000 * transactionInstructions.length, 1_400_000);
    console.log('DEBUG: Compute units:', computeUnits);

    // Prepare final instruction list
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
    console.log(`Jito tip preparation took: ${Date.now() - jitoStartTime}ms`);
    
    instructions.push(jitoTip);
    instructions.push(...transactionInstructions);

    const preSlot = await connection.getSlot("processed");
    console.log(`Sending transaction in slot: ${preSlot}`);

    // Final transaction assembly
    console.log('DEBUG: Assembling final transaction...');
    const messageV0 = new TransactionMessage({
        payerKey: wallet.publicKey,
        recentBlockhash: blockhash,
        instructions
    }).compileToV0Message();

    const transaction = new VersionedTransaction(messageV0);
    transaction.sign([wallet]);

    console.log('DEBUG: Sending transaction...');
    const startTime = Date.now();
    const signature = await sendJitoTransaction(transaction, { skipPreflight: true });

    // Time confirmation wait
    const confirmStartTime = Date.now();
    console.log('DEBUG: Awaiting confirmation...');
    await connection.confirmTransaction({
        signature,
        blockhash,
        lastValidBlockHeight
    });
    const confirmedSlot = await connection.getSlot("confirmed");
    const confirmTime = Date.now() - confirmStartTime;
    const endTime = Date.now();
    console.log(`Transaction confirmation took: ${confirmTime}ms`);

    console.log('\nFinal Transaction Details:');
    console.log(`Total transaction time: ${(endTime - startTime) / 1000} seconds`);
    console.log(`Transaction sent in slot: ${preSlot}`);
    console.log(`Transaction confirmed in slot: ${confirmedSlot}`);
    console.log(`Slots traversed: ${confirmedSlot - preSlot}`);
    console.log(`Explorer link: https://solscan.io/tx/${signature}`);

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
                console.log('Found cached token type information');
                if (cachedInfo.type === 'regular') {
                    isPump = false;
                    hasMigrated = false;
                } else if (cachedInfo.type === 'migratedPump') {
                    isPump = false;
                    hasMigrated = true;
                }
            } else {
                // No cache hit, need to check token type
                console.log('Checking token type...');
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