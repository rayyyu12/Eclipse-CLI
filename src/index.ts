import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { isPumpFunToken, swapSolToPumpToken } from './utils/swaps/pumpSwap';
import { swapSolToToken, sellTokens } from './utils/swaps/regularSwap';
import { PortfolioTracker } from './utils/positions/portfolioTracker';
import { CredentialsManager } from "./cli/utils/credentialsManager";
export { setupConnection };

process.removeAllListeners('warning');

const MIN_SOL_REQUIRED = 0.001;
const BUFFER_SOL = 0.01;
const MAX_RETRIES = 3;
const RETRY_DELAY = 1000; // 1 second

async function setupConnection() {
    const credManager = CredentialsManager.getInstance();
    if (!credManager.hasBasicCredentials()) {  // <-- Changed to hasBasicCredentials
        throw new Error("Credentials not configured. Please set up RPC URL and private key in settings first.");
    }

    const connection = credManager.getConnection();
    const wallet = credManager.getKeyPair();

    return { connection, wallet };
}

async function displayPositions(connection: Connection) {
    try {
        const { wallet } = await setupConnection();
        const tracker = PortfolioTracker.getInstance();
        await tracker.displayPortfolio(connection, wallet.publicKey);
    } catch (error) {
        console.error('Error displaying positions:', error instanceof Error ? error.message : 'Unknown error');
        console.log('\nFailed to display portfolio. Try again later.');
    }
}

async function initializeSwapEnvironment(
    tokenAddress: string
): Promise<{
    connection: Connection;
    wallet: Keypair;
    tokenInfo: { isPump: boolean; hasMigrated: boolean };
    tokenPublicKey: PublicKey;
    walletBalance: number;
}> {
    const tokenPublicKey = new PublicKey(tokenAddress);
    const mightBePumpToken = tokenAddress.endsWith('pump');
    const { connection, wallet } = await setupConnection();
    const balancePromise = connection.getBalance(wallet.publicKey);

    let tokenInfo;
    if (mightBePumpToken) {
        tokenInfo = await isPumpFunToken(connection, tokenPublicKey);
    } else {
        tokenInfo = { isPump: false, hasMigrated: false };
    }

    const walletBalance = await balancePromise;

    return {
        connection,
        wallet,
        tokenInfo,
        tokenPublicKey,
        walletBalance
    };
}

async function handleBuyOperation(
    connection: Connection,
    wallet: Keypair,
    tokenPublicKey: PublicKey,
    tokenInfo: { isPump: boolean; hasMigrated: boolean }
): Promise<void> {
    let retryCount = MAX_RETRIES;
    let lastError: Error | null = null;

    while (retryCount > 0) {
        try {
            if (tokenInfo.isPump && !tokenInfo.hasMigrated) {
                console.log("This is an active pump.fun token. Using pump.fun swap...");
                const signature = await swapSolToPumpToken(
                    connection,
                    wallet,
                    tokenPublicKey,
                    MIN_SOL_REQUIRED,
                    0.01
                );
                console.log("Pump.fun swap successful!");
                console.log("Transaction signature:", signature);
                console.log(`Explorer link: https://solscan.io/tx/${signature}`);
                return;
            }

            console.log(tokenInfo.hasMigrated ? 
                "This is a migrated pump.fun token. Using regular swap..." : 
                "This is a regular token. Using regular swap..."
            );
            
            const signature = await swapSolToToken(
                connection,
                wallet,
                tokenPublicKey,
                MIN_SOL_REQUIRED * LAMPORTS_PER_SOL,
                0.01
            );
            console.log("Regular swap successful!");
            console.log("Transaction signature:", signature);
            console.log(`Explorer link: https://solscan.io/tx/${signature}`);
            return;

        } catch (error: any) {
            lastError = error;
            console.error(`Attempt ${MAX_RETRIES - retryCount + 1} failed:`, error.message);

            const isRetryableError = 
                error.message.includes("exceeded") ||
                error.message.includes("blockhash not found") ||
                error.message.includes("Transaction simulation failed") ||
                error.message.includes("Socket hang up");

            if (isRetryableError && retryCount > 1) {
                retryCount--;
                console.log(`Retrying in ${RETRY_DELAY/1000} seconds...`);
                await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
                continue;
            }
            
            throw formatError(error);
        }
    }

    throw lastError || new Error("Operation failed after maximum retries");
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
    
    return error;
}

async function main() {
    try {
        const command = process.argv[2];
        
        if (!command) {
            console.error("Error: Please provide a token address or command");
            console.error("Usage: npm start <token-address> (to buy tokens)");
            console.error("       npm start sell (to sell tokens)");
            console.error("       npm start positions (to view positions)");
            process.exit(1);
        }

        // Check credentials before proceeding
        const credManager = CredentialsManager.getInstance();
        if (!credManager.hasCredentials()) {
            console.error("Error: Credentials not configured");
            console.error("Please configure RPC URL and private key in settings first");
            process.exit(1);
        }

        if (command === "positions") {
            const { connection } = await setupConnection();
            await displayPositions(connection);
            return;
        }

        if (command === "sell") {
            await sellTokens();
            return;
        }

        try {
            const { 
                connection, 
                wallet, 
                tokenInfo, 
                tokenPublicKey, 
                walletBalance 
            } = await initializeSwapEnvironment(command);

            const requiredBalance = (MIN_SOL_REQUIRED + BUFFER_SOL) * LAMPORTS_PER_SOL;
            if (walletBalance < requiredBalance) {
                throw new Error(
                    `Insufficient SOL balance. Required: ${(requiredBalance / LAMPORTS_PER_SOL).toFixed(3)} SOL, ` +
                    `Current: ${(walletBalance / LAMPORTS_PER_SOL).toFixed(3)} SOL`
                );
            }

            await handleBuyOperation(connection, wallet, tokenPublicKey, tokenInfo);

        } catch (err) {
            if (err instanceof Error && err.message.includes("Invalid public key input")) {
                console.error("Error: Invalid token address format");
                process.exit(1);
            }
            throw err;
        }

    } catch (error: any) {
        console.error("Error:", error.message);
        process.exit(1);
    }
}

process.on('unhandledRejection', (error) => {
    console.error('Unhandled promise rejection:', error);
    process.exit(1);
});

process.on('uncaughtException', (error) => {
    console.error('Uncaught exception:', error);
    process.exit(1);
});

export default main;

if (require.main === module) {
    main();
}