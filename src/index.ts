import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { isPumpFunToken, swapSolToPumpToken } from './utils/swaps/pumpSwap';
import { swapSolToToken, sellTokens } from './utils/swaps/regularSwap';
import { PortfolioTracker } from './utils/positions/portfolioTracker';
import { CredentialsManager } from "./cli/utils/credentialsManager";
import chalk from 'chalk';
export { setupConnection };
import { COLORS } from './cli/config';

process.removeAllListeners('warning');

const MIN_SOL_REQUIRED = 0.001;
const BUFFER_SOL = 0.01;
const MAX_RETRIES = 3;
const RETRY_DELAY = 1000;

async function setupConnection() {
    const credManager = CredentialsManager.getInstance();
    if (!credManager.hasBasicCredentials()) {
        throw new Error("Credentials not configured. Please set up RPC URL and private key in settings first.");
    }
    return {
        connection: credManager.getConnection(),
        wallet: credManager.getKeyPair()
    };
}

async function displayPositions(connection: Connection) {
    const { wallet } = await setupConnection();
    const tracker = PortfolioTracker.getInstance();
    await tracker.displayPortfolio(connection, wallet.publicKey);
}

async function initializeSwapEnvironment(tokenAddress: string) {
    const tokenPublicKey = new PublicKey(tokenAddress);
    const { connection, wallet } = await setupConnection();
    const [walletBalance, tokenInfo] = await Promise.all([
        connection.getBalance(wallet.publicKey),
        tokenAddress.endsWith('pump') ? 
            isPumpFunToken(connection, tokenPublicKey) : 
            Promise.resolve({ isPump: false, hasMigrated: false })
    ]);

    return { connection, wallet, tokenInfo, tokenPublicKey, walletBalance };
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
            const signature = tokenInfo.isPump && !tokenInfo.hasMigrated ?
                await swapSolToPumpToken(connection, wallet, tokenPublicKey, MIN_SOL_REQUIRED, 0.01) :
                await swapSolToToken(connection, wallet, tokenPublicKey, MIN_SOL_REQUIRED * LAMPORTS_PER_SOL, 0.01);
            
            console.log(chalk.hex(COLORS.SUCCESS)(`Transaction successful: https://solscan.io/tx/${signature}`));
            return;
        } catch (error: any) {
            lastError = error;
            const isRetryableError = [
                "exceeded",
                "blockhash not found",
                "Transaction simulation failed",
                "Socket hang up"
            ].some(msg => error.message.includes(msg));

            if (isRetryableError && retryCount > 1) {
                retryCount--;
                await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
                continue;
            }
            throw formatError(error);
        }
    }
    throw lastError || new Error("Operation failed after maximum retries");
}

function formatError(error: any): Error {
    const errorMessages = {
        "No liquidity pool found": "No liquidity pool exists for this token pair",
        "insufficient funds": "Insufficient funds for swap",
        "exceeds desired slippage limit": "Price impact too high. Try increasing slippage tolerance or reducing amount",
        "0x1": "Transaction failed - check token contract and pool status"
    };

    const message = error.message || String(error);
    for (const [key, value] of Object.entries(errorMessages)) {
        if (message.includes(key)) return new Error(value);
    }
    return error;
}

async function main() {
    try {
        const command = process.argv[2];
        if (!command) {
            console.error(chalk.hex(COLORS.ERROR)("Usage:\nnpm start <token-address> (buy)\nnpm start sell (sell)\nnpm start positions (view)"));
            process.exit(1);
        }

        const credManager = CredentialsManager.getInstance();
        if (!credManager.hasCredentials()) {
            throw new Error("Please configure RPC URL and private key in settings first");
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

        const { connection, wallet, tokenInfo, tokenPublicKey, walletBalance } = 
            await initializeSwapEnvironment(command);

        const requiredBalance = (MIN_SOL_REQUIRED + BUFFER_SOL) * LAMPORTS_PER_SOL;
        if (walletBalance < requiredBalance) {
            throw new Error(
                `Insufficient SOL balance. Required: ${(requiredBalance / LAMPORTS_PER_SOL).toFixed(3)} SOL, ` +
                `Current: ${(walletBalance / LAMPORTS_PER_SOL).toFixed(3)} SOL`
            );
        }

        await handleBuyOperation(connection, wallet, tokenPublicKey, tokenInfo);

    } catch (error: any) {
        if (error instanceof Error && error.message.includes("Invalid public key input")) {
            throw new Error("Invalid token address format");
        }
        throw error;
    }
}

process.on('unhandledRejection', error => {
    console.error(chalk.hex(COLORS.ERROR)('Fatal error:', error));
    process.exit(1);
});

process.on('uncaughtException', error => {
    console.error(chalk.hex(COLORS.ERROR)('Fatal error:', error));
    process.exit(1);
});

export default main;

if (require.main === module) {
    main().catch(error => {
        console.error(chalk.hex(COLORS.ERROR)(error.message));
        process.exit(1);
    });
}