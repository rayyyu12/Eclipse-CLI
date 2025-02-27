"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.swapSolToToken = swapSolToToken;
exports.swapTokenToSol = swapTokenToSol;
exports.sellTokens = sellTokens;
//new regularSwap.ts
const web3_js_1 = require("@solana/web3.js");
const spl_token_1 = require("@solana/spl-token");
const bn_js_1 = __importDefault(require("bn.js"));
const persistentPoolCache_1 = require("../pools/persistentPoolCache");
const poolDiscovery_1 = require("../pools/poolDiscovery");
const swapBuilder_1 = require("./swapBuilder");
const jito_1 = require("../fees/jito");
const readline_1 = require("readline"); // Change this line
const pumpSwap_1 = require("./pumpSwap");
const tokenTypeCache_1 = require("../pools/tokenTypeCache");
const portfolioTracker_1 = require("../positions/portfolioTracker");
const settingsManager_1 = require("../../cli/utils/settingsManager");
const credentialsManager_1 = require("../../cli/utils/credentialsManager");
const blockhashManager_1 = require("./blockhashManager");
const MAX_RETRIES = 3;
const RETRY_DELAY = 1000; // 1 second
const MAX_PRICE_IMPACT = 0.1; // 10%
const POOL_FEE_BUFFER = 0.003; // 0.3%
const DEFAULT_PRIORITY_FEE = 100000;
const STATIC_COMPUTE_BUDGET_IX = web3_js_1.ComputeBudgetProgram.setComputeUnitPrice({
    microLamports: 100000 // Default value, can be overridden if needed
});
function calculateOutputAmount(amountIn, poolCoinBalance, poolPcBalance, tokenDecimals) {
    // Adjust for decimal difference between token (6) and SOL (9)
    const decimalAdjustment = Math.pow(10, 9 - tokenDecimals); // Should still be 1000 for 6 decimal token
    // Calculate output using pool ratio with decimal adjustment
    const rawExpectedOutput = (amountIn * poolPcBalance) / (poolCoinBalance * decimalAdjustment);
    // Apply the additional shift that was in the original code
    const expectedOutput = Math.floor(rawExpectedOutput * Math.pow(10, -4));
    return expectedOutput;
}
async function swapSolToToken(connection, wallet, outputToken, amountIn, slippageTolerance = 0.5) {
    if (amountIn <= 0)
        throw new Error("Amount must be greater than 0");
    const poolCache = persistentPoolCache_1.PersistentPoolCache.getInstance();
    const [mint1, mint2] = [spl_token_1.NATIVE_MINT.toString(), outputToken.toString()].sort();
    const poolId = `${mint1}/${mint2}`;
    const poolStartTime = Date.now();
    const poolCachePromise = (async () => {
        let poolAccounts = poolCache.get(poolId);
        if (!poolAccounts) {
            poolAccounts = await (0, poolDiscovery_1.discoverPool)(connection, spl_token_1.NATIVE_MINT, outputToken, true);
            if (poolAccounts)
                poolCache.set(poolId, poolAccounts);
        }
        return poolAccounts;
    })();
    const fetchStartTime = Date.now();
    // Get settings first to determine if we need to fetch priority fee
    const settings = settingsManager_1.SettingsManager.getInstance().getSettings();
    // Fetch initial data in parallel
    const [userWSOLAccount, userDestinationTokenAccount, tokenMintInfo, priorityFeeResponse, poolAccounts] = await Promise.all([
        (async () => {
            const start = Date.now();
            const result = await (0, spl_token_1.getAssociatedTokenAddress)(spl_token_1.NATIVE_MINT, wallet.publicKey, false);
            return result;
        })(),
        (async () => {
            const start = Date.now();
            const result = await (0, spl_token_1.getAssociatedTokenAddress)(outputToken, wallet.publicKey, false);
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
    const { blockhash, lastValidBlockHeight } = await blockhashManager_1.BlockhashManager.getInstance().getBlockhash();
    if (!poolAccounts)
        throw new Error("No liquidity pool found");
    if (!tokenMintInfo.value) {
        throw new Error("Invalid token mint address");
    }
    const tokenDecimals = tokenMintInfo.value?.data?.parsed?.info?.decimals || 9;
    // Time pre-swap balance check
    const preSwapStartTime = Date.now();
    const preSwapAccount = await (0, spl_token_1.getAccount)(connection, userDestinationTokenAccount)
        .catch(() => null);
    const preSwapBalance = preSwapAccount ? Number(preSwapAccount.amount) : 0;
    // Handle priority fee based on settings
    let priorityFeeEstimate;
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
            }
            catch (error) {
                console.log(`Using default priority fee (${DEFAULT_PRIORITY_FEE} microLamports/cu) due to error:`, error);
            }
        }
    }
    else {
        priorityFeeEstimate = settings.fees.fixedPriorityFee || DEFAULT_PRIORITY_FEE;
    }
    // Build transaction instructions
    const transactionInstructions = [];
    // Use idempotent ATA creation instructions - no need to check existence
    transactionInstructions.push((0, spl_token_1.createAssociatedTokenAccountIdempotentInstruction)(wallet.publicKey, userDestinationTokenAccount, wallet.publicKey, outputToken), (0, spl_token_1.createAssociatedTokenAccountIdempotentInstruction)(wallet.publicKey, userWSOLAccount, wallet.publicKey, spl_token_1.NATIVE_MINT));
    // Add core swap instructions
    transactionInstructions.push(web3_js_1.SystemProgram.transfer({
        fromPubkey: wallet.publicKey,
        toPubkey: userWSOLAccount,
        lamports: amountIn
    }));
    transactionInstructions.push((0, spl_token_1.createSyncNativeInstruction)(userWSOLAccount));
    const amountInBN = new bn_js_1.default(amountIn.toString());
    const minAmountOutBN = amountInBN.mul(new bn_js_1.default(1000 - (slippageTolerance * 1000))).div(new bn_js_1.default(1000));
    // Time swap instruction building
    const swapInstructionStartTime = Date.now();
    transactionInstructions.push(await (0, swapBuilder_1.buildSwapInstruction)(wallet.publicKey, userWSOLAccount, userDestinationTokenAccount, poolAccounts, amountInBN, minAmountOutBN, true));
    // Calculate compute units and prepare final instructions
    const computeUnits = Math.min(200000 * transactionInstructions.length, 1400000);
    const instructions = [];
    instructions.push(web3_js_1.ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnits }), web3_js_1.ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFeeEstimate }));
    // Time Jito tip preparation
    const jitoStartTime = Date.now();
    const jitoTip = await (0, jito_1.prepareJitoTip)(priorityFeeEstimate, wallet.publicKey, false // silent mode
    );
    instructions.push(jitoTip);
    instructions.push(...transactionInstructions);
    const preSlot = await connection.getSlot("processed");
    // Build and send transaction
    const messageV0 = new web3_js_1.TransactionMessage({
        payerKey: wallet.publicKey,
        recentBlockhash: blockhash,
        instructions
    }).compileToV0Message();
    const transaction = new web3_js_1.VersionedTransaction(messageV0);
    transaction.sign([wallet]);
    const startTime = Date.now();
    const signature = await (0, jito_1.sendJitoTransaction)(transaction, { skipPreflight: true });
    // Time confirmation wait
    const confirmStartTime = Date.now();
    await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight });
    const confirmedSlot = await connection.getSlot("confirmed");
    const confirmTime = Date.now() - confirmStartTime;
    const endTime = Date.now();
    // Time post-swap operations
    const postSwapStartTime = Date.now();
    const postSwapAccount = await (0, spl_token_1.getAccount)(connection, userDestinationTokenAccount);
    const postSwapBalance = Number(postSwapAccount.amount);
    const tokensReceived = (postSwapBalance - preSwapBalance) / Math.pow(10, tokenDecimals);
    // Calculate actual entry price
    const actualEntryPrice = amountIn / web3_js_1.LAMPORTS_PER_SOL / tokensReceived;
    // Time portfolio update
    const portfolioStartTime = Date.now();
    const tracker = portfolioTracker_1.PortfolioTracker.getInstance();
    await tracker.addPosition(outputToken.toString(), amountIn / web3_js_1.LAMPORTS_PER_SOL, tokensReceived, signature, {
        entryPriceOverride: actualEntryPrice,
        isPumpToken: false
    });
    // Log transaction details
    return signature;
}
async function swapTokenToSol(connection, wallet, inputToken, percentageToSell, slippageTolerance = 0.2) {
    if (percentageToSell <= 0 || percentageToSell > 100) {
        throw new Error("Percentage must be between 0 and 100");
    }
    const poolCache = persistentPoolCache_1.PersistentPoolCache.getInstance();
    const [mint1, mint2] = [spl_token_1.NATIVE_MINT.toString(), inputToken.toString()].sort();
    const poolId = `${mint1}/${mint2}`;
    const poolCachePromise = (async () => {
        let poolAccounts = poolCache.get(poolId);
        if (!poolAccounts) {
            poolAccounts = await (0, poolDiscovery_1.discoverPool)(connection, spl_token_1.NATIVE_MINT, inputToken, true);
            if (poolAccounts)
                poolCache.set(poolId, poolAccounts);
        }
        return poolAccounts;
    })();
    const settings = settingsManager_1.SettingsManager.getInstance().getSettings();
    const [tokenMint, userTokenAccount, userWSOLAccount, walletBalance, poolAccounts, { blockhash, lastValidBlockHeight }] = await Promise.all([
        connection.getParsedAccountInfo(inputToken, "processed"),
        (0, spl_token_1.getAssociatedTokenAddress)(inputToken, wallet.publicKey, false),
        (0, spl_token_1.getAssociatedTokenAddress)(spl_token_1.NATIVE_MINT, wallet.publicKey, false),
        connection.getBalance(wallet.publicKey, "processed"),
        poolCachePromise,
        blockhashManager_1.BlockhashManager.getInstance().getBlockhash()
    ]);
    if (!poolAccounts) {
        throw new Error("No liquidity pool found for this token");
    }
    const tokenDecimals = tokenMint.value?.data?.parsed?.info?.decimals || 9;
    const [tokenAccountInfo, wsolAccountInfo, existingWsolBalance] = await Promise.all([
        (0, spl_token_1.getAccount)(connection, userTokenAccount),
        connection.getAccountInfo(userWSOLAccount, "processed"),
        (async () => {
            try {
                const balance = await connection.getTokenAccountBalance(userWSOLAccount);
                return balance.value.uiAmount;
            }
            catch {
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
        (0, spl_token_1.getAccount)(connection, poolAccounts.poolCoinTokenAccount),
        (0, spl_token_1.getAccount)(connection, poolAccounts.poolPcTokenAccount)
    ]);
    if (!poolCoinAccount || !poolPcAccount) {
        throw new Error("Failed to fetch pool token accounts");
    }
    const poolCoinBalance = Number(poolCoinAccount.amount);
    const poolPcBalance = Number(poolPcAccount.amount);
    const expectedOutput = calculateOutputAmount(amountToSell, poolCoinBalance, poolPcBalance, tokenDecimals);
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
        }
        catch (error) {
            priorityFeeEstimate = DEFAULT_PRIORITY_FEE;
        }
    }
    else {
        priorityFeeEstimate = settings.fees.fixedPriorityFee || DEFAULT_PRIORITY_FEE;
    }
    const amountInBN = new bn_js_1.default(amountToSell.toString());
    const minAmountOutBN = new bn_js_1.default(Math.floor(expectedOutput * (1 - slippageTolerance - POOL_FEE_BUFFER)));
    const transactionInstructions = [];
    transactionInstructions.push((0, spl_token_1.createAssociatedTokenAccountIdempotentInstruction)(wallet.publicKey, userWSOLAccount, wallet.publicKey, spl_token_1.NATIVE_MINT));
    transactionInstructions.push(await (0, swapBuilder_1.buildSwapInstruction)(wallet.publicKey, userTokenAccount, userWSOLAccount, poolAccounts, amountInBN, minAmountOutBN, true));
    if (!existingWsolBalance) {
        transactionInstructions.push((0, spl_token_1.createCloseAccountInstruction)(userWSOLAccount, wallet.publicKey, wallet.publicKey));
    }
    const computeUnits = Math.min(200000 * transactionInstructions.length, 1400000);
    const instructions = [];
    instructions.push(web3_js_1.ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnits }), web3_js_1.ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFeeEstimate }));
    const jitoTip = await (0, jito_1.prepareJitoTip)(priorityFeeEstimate, wallet.publicKey, false);
    instructions.push(jitoTip);
    instructions.push(...transactionInstructions);
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
    });
    console.log("✔ Sell successful!");
    console.log("Transaction Details:");
    console.log(`Signature: ${signature}`);
    console.log(`Explorer: https://solscan.io/tx/${signature}`);
    return signature;
}
async function sellTokens() {
    const rl = (0, readline_1.createInterface)({
        input: process.stdin,
        output: process.stdout,
        terminal: false
    });
    try {
        const askQuestion = (query) => {
            return new Promise((resolve) => {
                process.stdout.write(query);
                rl.once('line', (line) => resolve(line));
            });
        };
        // Get token address from user
        const tokenAddress = await askQuestion("Enter the token address you want to sell: ");
        let tokenPublicKey;
        try {
            tokenPublicKey = new web3_js_1.PublicKey(tokenAddress);
        }
        catch (err) {
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
        const credManager = credentialsManager_1.CredentialsManager.getInstance();
        if (!credManager.hasCredentials()) {
            console.error("Error: Missing RPC URL or private key in credentials");
            console.error("Please configure them in settings first");
            process.exit(1);
        }
        const connection = credManager.getConnection();
        const wallet = credManager.getKeyPair();
        try {
            // Check token type cache first
            const tokenCache = tokenTypeCache_1.TokenTypeCache.getInstance();
            const cachedInfo = tokenCache.getTokenType(tokenAddress);
            // Initialize variables for token type
            let isPump = false;
            let hasMigrated = false;
            if (cachedInfo) {
                if (cachedInfo.type === 'regular') {
                    isPump = false;
                    hasMigrated = false;
                }
                else if (cachedInfo.type === 'migratedPump') {
                    isPump = false;
                    hasMigrated = true;
                }
            }
            else {
                // No cache hit, need to check token type
                const tokenInfo = await (0, pumpSwap_1.isPumpFunToken)(connection, tokenAddress);
                isPump = tokenInfo.isPump;
                hasMigrated = tokenInfo.hasMigrated;
            }
            if (isPump) {
                // Check for Raydium pools first for migrated tokens
                const poolCache = persistentPoolCache_1.PersistentPoolCache.getInstance();
                const [mint1, mint2] = [spl_token_1.NATIVE_MINT.toString(), tokenAddress].sort();
                const poolId = `${mint1}/${mint2}`;
                let hasRaydiumPool = false;
                const cachedPool = poolCache.get(poolId);
                if (cachedPool) {
                    console.log('Found cached pool information');
                    hasRaydiumPool = true;
                }
                else {
                    try {
                        const poolAccounts = await (0, poolDiscovery_1.discoverPool)(connection, spl_token_1.NATIVE_MINT, tokenPublicKey, true);
                        if (poolAccounts) {
                            hasRaydiumPool = true;
                            poolCache.set(poolId, poolAccounts);
                            // Cache as migrated pump token
                            tokenCache.setTokenType(tokenAddress, 'migratedPump');
                        }
                    }
                    catch (err) {
                        hasRaydiumPool = false;
                    }
                }
                if (hasRaydiumPool) {
                    console.log("Found Raydium pool for pump.fun token. Using regular swap...");
                    const signature = await swapTokenToSol(connection, wallet, tokenPublicKey, percentage, 0.2);
                    console.log("Regular swap successful!");
                    console.log("Transaction signature:", signature);
                    console.log(`Explorer link: https://solscan.io/tx/${signature}`);
                }
                else {
                    console.log("No Raydium pool found. Using pump.fun sell mechanism...");
                    try {
                        const signature = await (0, pumpSwap_1.swapPumpTokenToSol)(connection, wallet, tokenPublicKey, percentage, 0.2);
                        console.log("Pump.fun swap successful!");
                        console.log("Transaction signature:", signature);
                        console.log(`Explorer link: https://solscan.io/tx/${signature}`);
                    }
                    catch (err) {
                        const error = err;
                        if (error.message.includes("BondingCurveComplete")) {
                            console.error("Error: This token has already migrated to Raydium. Please use regular swap.");
                        }
                        else if (error.message.includes("TooLittleSolReceived")) {
                            console.error("Error: Price impact too high. Try reducing the amount or increasing slippage tolerance");
                        }
                        else {
                            console.error("Error during pump.fun swap:", error.message);
                        }
                        process.exit(1);
                    }
                }
            }
            else {
                // Regular token or migrated pump token, use normal Raydium swap
                const signature = await swapTokenToSol(connection, wallet, tokenPublicKey, percentage, 0.2);
                console.log("Regular swap successful!");
                console.log("Transaction signature:", signature);
                console.log(`Explorer link: https://solscan.io/tx/${signature}`);
            }
        }
        catch (err) {
            const error = err;
            if (error.message.includes("No liquidity pool found")) {
                console.error("Error: No liquidity pool exists for this token pair");
            }
            else if (error.message.includes("insufficient funds")) {
                console.error("Error: Insufficient funds for swap");
            }
            else if (error.message.includes("exceeds desired slippage limit")) {
                console.error("Error: Price impact too high. Try reducing the amount or increasing slippage tolerance");
            }
            else {
                console.error("Error performing swap:", error.message);
            }
            process.exit(1);
        }
    }
    catch (err) {
        const error = err;
        console.error("Fatal error:", error.message);
        process.exit(1);
    }
    finally {
        rl.close();
    }
}
