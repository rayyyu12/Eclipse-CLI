//regularSwap.ts
import { Connection, Keypair, TransactionMessage, VersionedTransaction, ComputeBudgetProgram, PublicKey, TransactionInstruction, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { getAssociatedTokenAddress, createAssociatedTokenAccountIdempotentInstruction, createCloseAccountInstruction, createSyncNativeInstruction, NATIVE_MINT, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import BN from 'bn.js';
import { createInterface } from 'readline';
import chalk from 'chalk';
import { PersistentPoolCache } from '../pools/persistentPoolCache';
import { discoverPool } from '../pools/poolDiscovery';
import { buildSwapInstruction } from './swapBuilder';
import { sendJitoTransaction, prepareJitoTip } from '../fees/jito';
import { isPumpFunToken, swapPumpTokenToSol } from "./pumpSwap";
import { TokenTypeCache } from "../pools/tokenTypeCache";
import { PortfolioTracker } from '../positions/portfolioTracker';
import { SettingsManager } from "../../cli/utils/settingsManager";
import { CredentialsManager } from "../../cli/utils/credentialsManager";
import { BlockhashManager } from "./blockhashManager";
import { COLORS } from "../../cli/config";

const POOL_FEE_BUFFER = 0.003;
const DEFAULT_PRIORITY_FEE = 100_000;

function calculateOutputAmount(
    amountIn: number,
    poolCoinBalance: number,
    poolPcBalance: number,
    tokenDecimals: number
): number {
    const decimalAdjustment = Math.pow(10, 9 - tokenDecimals);
    const rawExpectedOutput = (amountIn * poolPcBalance) / (poolCoinBalance * decimalAdjustment);
    return Math.floor(rawExpectedOutput * Math.pow(10, -4));
}

export async function swapSolToToken(
    connection: Connection,
    wallet: Keypair,
    outputToken: PublicKey,
    amountIn: number,
    slippageTolerance: number = 0.5
): Promise<string> {
    if (amountIn <= 0) throw new Error(chalk.hex(COLORS.ERROR)("Amount must be greater than 0"));

    const poolCache = PersistentPoolCache.getInstance();
    const [mint1, mint2] = [NATIVE_MINT.toString(), outputToken.toString()].sort();
    const poolId = `${mint1}/${mint2}`;

    const poolAccounts = await (async () => {
        let accounts = poolCache.get(poolId);
        if (!accounts) {
            accounts = await discoverPool(connection, NATIVE_MINT, outputToken, true);
            if (accounts) poolCache.set(poolId, accounts);
        }
        return accounts;
    })();

    const settings = SettingsManager.getInstance().getSettings();
    
    const [
        userWSOLAccount,
        userDestinationTokenAccount,
        tokenMintInfo,
        priorityFeeResponse,
        { blockhash, lastValidBlockHeight }
    ] = await Promise.all([
        getAssociatedTokenAddress(NATIVE_MINT, wallet.publicKey, false),
        getAssociatedTokenAddress(outputToken, wallet.publicKey, false),
        connection.getParsedAccountInfo(outputToken, "processed"),
        settings.fees.useAutomaticPriorityFee ? 
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
            }) : Promise.resolve(null),
        BlockhashManager.getInstance().getBlockhash()
    ]);

    if (!poolAccounts) throw new Error(chalk.hex(COLORS.ERROR)("No liquidity pool found"));
    if (!tokenMintInfo.value) throw new Error(chalk.hex(COLORS.ERROR)("Invalid token mint address"));

    const tokenDecimals = (tokenMintInfo.value?.data as any)?.parsed?.info?.decimals || 9;
    const preSwapAccount = await connection.getTokenAccountBalance(userDestinationTokenAccount).catch(() => null);
    const preSwapBalance = preSwapAccount ? Number(preSwapAccount.value.amount) : 0;

    let priorityFeeEstimate = settings.fees.useAutomaticPriorityFee ?
        (priorityFeeResponse && priorityFeeResponse.ok ? 
            (await priorityFeeResponse.json())?.result?.priorityFeeEstimate || DEFAULT_PRIORITY_FEE :
            DEFAULT_PRIORITY_FEE) :
        settings.fees.fixedPriorityFee || DEFAULT_PRIORITY_FEE;

    const instructions: TransactionInstruction[] = [
        createAssociatedTokenAccountIdempotentInstruction(
            wallet.publicKey, userDestinationTokenAccount, wallet.publicKey, outputToken
        ),
        createAssociatedTokenAccountIdempotentInstruction(
            wallet.publicKey, userWSOLAccount, wallet.publicKey, NATIVE_MINT
        ),
        SystemProgram.transfer({
            fromPubkey: wallet.publicKey,
            toPubkey: userWSOLAccount,
            lamports: amountIn
        }),
        createSyncNativeInstruction(userWSOLAccount)
    ];

    const amountInBN = new BN(amountIn.toString());
    const minAmountOutBN = amountInBN.mul(new BN(1000 - (slippageTolerance * 1000))).div(new BN(1000));

    instructions.push(
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

    const computeUnits = Math.min(200_000 * instructions.length, 1_400_000);
    const finalInstructions = [
        ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnits }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFeeEstimate }),
        await prepareJitoTip(priorityFeeEstimate, wallet.publicKey, true),
        ...instructions
    ];

    const messageV0 = new TransactionMessage({
        payerKey: wallet.publicKey,
        recentBlockhash: blockhash,
        instructions: finalInstructions
    }).compileToV0Message();

    const transaction = new VersionedTransaction(messageV0);
    transaction.sign([wallet]);

    const signature = await sendJitoTransaction(transaction, { skipPreflight: true });
    await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight });

    const postSwapAccount = await connection.getTokenAccountBalance(userDestinationTokenAccount);
    const tokensReceived = (Number(postSwapAccount.value.amount) - preSwapBalance) / Math.pow(10, tokenDecimals);
    const actualEntryPrice = amountIn / LAMPORTS_PER_SOL / tokensReceived;

    await PortfolioTracker.getInstance().addPosition(
        outputToken.toString(),
        amountIn / LAMPORTS_PER_SOL,
        tokensReceived,
        signature,
        {
            entryPriceOverride: actualEntryPrice,
            isPumpToken: false
        }
    );

    console.log(chalk.hex(COLORS.SUCCESS)(`Transaction successful: https://solscan.io/tx/${signature}`));
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
        throw new Error(chalk.hex(COLORS.ERROR)("Percentage must be between 0 and 100"));
    }

    const poolCache = PersistentPoolCache.getInstance();
    const [mint1, mint2] = [NATIVE_MINT.toString(), inputToken.toString()].sort();
    const poolId = `${mint1}/${mint2}`;
    
    const poolAccounts = await (async () => {
        let accounts = poolCache.get(poolId);
        if (!accounts) {
            accounts = await discoverPool(connection, NATIVE_MINT, inputToken, true);
            if (accounts) poolCache.set(poolId, accounts);
        }
        return accounts;
    })();

    const settings = SettingsManager.getInstance().getSettings();

    const [
        tokenMint,
        userTokenAccount,
        userWSOLAccount,
        walletBalance,
        { blockhash, lastValidBlockHeight }
    ] = await Promise.all([
        connection.getParsedAccountInfo(inputToken, "processed"),
        getAssociatedTokenAddress(inputToken, wallet.publicKey, false),
        getAssociatedTokenAddress(NATIVE_MINT, wallet.publicKey, false),
        connection.getBalance(wallet.publicKey, "processed"),
        BlockhashManager.getInstance().getBlockhash()
    ]);

    if (!poolAccounts) throw new Error(chalk.hex(COLORS.ERROR)("No liquidity pool found for this token"));

    const tokenDecimals = (tokenMint.value?.data as any)?.parsed?.info?.decimals || 9;
    const [tokenAccountInfo, wsolAccountInfo, existingWsolBalance] = await Promise.all([
        connection.getTokenAccountBalance(userTokenAccount),
        connection.getAccountInfo(userWSOLAccount, "processed"),
        connection.getTokenAccountBalance(userWSOLAccount).catch(() => null)
    ]);

    if (!tokenAccountInfo) throw new Error(chalk.hex(COLORS.ERROR)("No token account found"));

    const tokenBalance = Number(tokenAccountInfo.value.amount);
    const amountToSell = Math.floor(tokenBalance * (percentageToSell / 100));

    if (amountToSell <= 0) throw new Error(chalk.hex(COLORS.ERROR)("Calculated sell amount is too small"));

    const [poolCoinAccount, poolPcAccount] = await Promise.all([
        connection.getTokenAccountBalance(poolAccounts.poolCoinTokenAccount),
        connection.getTokenAccountBalance(poolAccounts.poolPcTokenAccount)
    ]);

    if (!poolCoinAccount || !poolPcAccount) throw new Error("Failed to fetch pool token accounts");

    const poolCoinBalance = Number(poolCoinAccount.value.amount);
    const poolPcBalance = Number(poolPcAccount.value.amount);
    const expectedOutput = calculateOutputAmount(amountToSell, poolCoinBalance, poolPcBalance, tokenDecimals);

    let priorityFeeEstimate = settings.fees.useAutomaticPriorityFee ? 
        DEFAULT_PRIORITY_FEE : settings.fees.fixedPriorityFee || DEFAULT_PRIORITY_FEE;

    if (settings.fees.useAutomaticPriorityFee) {
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
                priorityFeeEstimate = data?.result?.priorityFeeEstimate || DEFAULT_PRIORITY_FEE;
            }
        } catch {}
    }

    const amountInBN = new BN(amountToSell.toString());
    const minAmountOutBN = new BN(Math.floor(expectedOutput * (1 - slippageTolerance - POOL_FEE_BUFFER)));

    const transactionInstructions: TransactionInstruction[] = [
        createAssociatedTokenAccountIdempotentInstruction(
            wallet.publicKey,
            userWSOLAccount,
            wallet.publicKey,
            NATIVE_MINT
        ),
        await buildSwapInstruction(
            wallet.publicKey,
            userTokenAccount,
            userWSOLAccount,
            poolAccounts,
            amountInBN,
            minAmountOutBN,
            true
        )
    ];

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
    const finalInstructions = [
        ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnits }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFeeEstimate }),
        await prepareJitoTip(priorityFeeEstimate, wallet.publicKey, true),
        ...transactionInstructions
    ];

    const messageV0 = new TransactionMessage({
        payerKey: wallet.publicKey,
        recentBlockhash: blockhash,
        instructions: finalInstructions
    }).compileToV0Message();

    const transaction = new VersionedTransaction(messageV0);
    transaction.sign([wallet]);

    const signature = await sendJitoTransaction(transaction, { skipPreflight: true });
    await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight });

    console.log(chalk.hex(COLORS.SUCCESS)(`Transaction successful: https://solscan.io/tx/${signature}`));
    return signature;
}

export async function sellTokens(): Promise<void> {
    const rl = createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: false
    });

    const askQuestion = (query: string): Promise<string> => {
        return new Promise((resolve) => {
            process.stdout.write(query);
            rl.once('line', (line) => resolve(line));
        });
    };

    try {
        const tokenAddress = await askQuestion(chalk.hex(COLORS.PRIMARY)("Enter the token address you want to sell: "));
        let tokenPublicKey: PublicKey;
        
        try {
            tokenPublicKey = new PublicKey(tokenAddress);
        } catch {
            throw new Error(chalk.hex(COLORS.ERROR)("Invalid token address format"));
        }

        const percentageStr = await askQuestion(chalk.hex(COLORS.PRIMARY)("Enter the percentage of tokens you want to sell (1-100): "));
        const percentage = parseFloat(percentageStr);
        
        if (isNaN(percentage) || percentage <= 0 || percentage > 100) {
            throw new Error(chalk.hex(COLORS.ERROR)("Invalid percentage. Must be between 1 and 100"));
        }

        const credManager = CredentialsManager.getInstance();
        if (!credManager.hasCredentials()) {
            throw new Error(chalk.hex(COLORS.ERROR)("Please configure RPC URL and private key in settings first"));
        }

        const connection = credManager.getConnection();
        const wallet = credManager.getKeyPair();

        const tokenCache = TokenTypeCache.getInstance();
        const cachedInfo = tokenCache.getTokenType(tokenAddress);
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
            const tokenInfo = await isPumpFunToken(connection, tokenAddress);
            isPump = tokenInfo.isPump;
            hasMigrated = tokenInfo.hasMigrated;
        }

        if (isPump) {
            const poolCache = PersistentPoolCache.getInstance();
            const [mint1, mint2] = [NATIVE_MINT.toString(), tokenAddress].sort();
            const poolId = `${mint1}/${mint2}`;
            let hasRaydiumPool = false;

            const cachedPool = poolCache.get(poolId);
            if (cachedPool) {
                hasRaydiumPool = true;
            } else {
                try {
                    const poolAccounts = await discoverPool(connection, NATIVE_MINT, tokenPublicKey, true);
                    if (poolAccounts) {
                        hasRaydiumPool = true;
                        poolCache.set(poolId, poolAccounts);
                        tokenCache.setTokenType(tokenAddress, 'migratedPump');
                    }
                } catch {
                    hasRaydiumPool = false;
                }
            }

            let signature: string;
            if (hasRaydiumPool) {
                signature = await swapTokenToSol(connection, wallet, tokenPublicKey, percentage, 0.2);
            } else {
                try {
                    signature = await swapPumpTokenToSol(connection, wallet, tokenPublicKey, percentage, 0.2);
                } catch (error: any) {
                    if (error.message.includes("BondingCurveComplete")) {
                        throw new Error(chalk.hex(COLORS.ERROR)("This token has already migrated to Raydium. Please use regular swap."));
                    } else if (error.message.includes("TooLittleSolReceived")) {
                        throw new Error(chalk.hex(COLORS.ERROR)("Price impact too high. Try reducing the amount or increasing slippage tolerance"));
                    }
                    throw error;
                }
            }
            console.log(chalk.hex(COLORS.SUCCESS)(`Transaction successful: https://solscan.io/tx/${signature}`));
        } else {
            const signature = await swapTokenToSol(connection, wallet, tokenPublicKey, percentage, 0.2);
            console.log(chalk.hex(COLORS.SUCCESS)(`Transaction successful: https://solscan.io/tx/${signature}`));
        }

    } catch (error: any) {
        console.error(chalk.hex(COLORS.ERROR)(error.message));
        process.exit(1);
    } finally {
        rl.close();
    }
}