//sellhandler.ts
import { PublicKey } from "@solana/web3.js";
import { setupConnection } from '../../index';
import { swapTokenToSol } from '../../utils/swaps/regularSwap';
import { validatePublicKey } from '../utils/validation';
import { promptWithValidation, spinner, displayError, displaySuccess } from '../utils/formatting';
import { isPumpFunToken, swapPumpTokenToSol } from '../../utils/swaps/pumpSwap';
import { PersistentPoolCache } from '../../utils/pools/persistentPoolCache';
import { TokenTypeCache } from '../../utils/pools/tokenTypeCache';
import { NATIVE_MINT } from "@solana/spl-token";
import { discoverPool } from '../../utils/pools/poolDiscovery';
import { BlockhashManager } from '../../utils/swaps/blockhashManager';
import chalk from 'chalk';
import { COLORS } from '../config';

export async function handleSell(): Promise<void> {
    try {
        // Get token address
        const tokenAddress = await promptWithValidation(
            'Enter token address to sell: ',
            validatePublicKey,
            'Invalid token address format!'
        );

        // Get percentage
        const percentage = await promptWithValidation(
            'Enter percentage to sell (1-100): ',
            (input: string) => {
                const num = parseFloat(input);
                return !isNaN(num) && num > 0 && num <= 100;
            },
            'Invalid percentage! Please enter a number between 1 and 100.'
        );

        const tokenPublicKey = new PublicKey(tokenAddress);
        spinner.start('Checking token type...');

        const { connection, wallet } = await setupConnection();

        // Initialize BlockhashManager before any swap operations
        BlockhashManager.getInstance().initialize(connection);

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
            try {
                const tokenInfo = await isPumpFunToken(connection, tokenAddress);
                isPump = tokenInfo.isPump;
                hasMigrated = tokenInfo.hasMigrated;
            } catch (error) {
                BlockhashManager.getInstance().cleanup(); // Cleanup on token check error
                throw error;
            }
        }

        if (isPump) {
            // Check for Raydium pools first for migrated tokens
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
                } catch (err) {
                    hasRaydiumPool = false;
                }
            }

            let signature: string;
            try {
                if (hasRaydiumPool) {
                    spinner.text = 'Using Raydium swap for migrated pump token...';
                    signature = await swapTokenToSol(
                        connection,
                        wallet,
                        tokenPublicKey,
                        parseFloat(percentage),
                        0.2
                    );
                } else {
                    spinner.text = 'Using pump.fun swap mechanism...';
                    signature = await swapPumpTokenToSol(
                        connection,
                        wallet,
                        tokenPublicKey,
                        parseFloat(percentage),
                        0.2
                    );
                }

                // Cleanup BlockhashManager after successful swap
                BlockhashManager.getInstance().cleanup();

                displaySuccess('Swap successful!');
                console.log(chalk.hex(COLORS.SUCCESS)("\nTransaction Details:"));
                console.log("Signature:", chalk.hex(COLORS.PRIMARY)(signature));
                console.log("Explorer:", chalk.hex(COLORS.PRIMARY)(`https://solscan.io/tx/${signature}`));

            } catch (error) {
                BlockhashManager.getInstance().cleanup(); // Cleanup on swap error
                throw error;
            }
        } else {
            // Regular token or migrated pump token
            try {
                spinner.text = 'Executing regular swap...';
                const signature = await swapTokenToSol(
                    connection,
                    wallet,
                    tokenPublicKey,
                    parseFloat(percentage),
                    0.2
                );

                // Cleanup BlockhashManager after successful swap
                BlockhashManager.getInstance().cleanup();

                displaySuccess('Swap successful!');
                console.log(chalk.hex(COLORS.SUCCESS)("\nTransaction Details:"));
                console.log("Signature:", chalk.hex(COLORS.PRIMARY)(signature));
                console.log("Explorer:", chalk.hex(COLORS.PRIMARY)(`https://solscan.io/tx/${signature}`));

            } catch (error) {
                BlockhashManager.getInstance().cleanup(); // Cleanup on swap error
                throw error;
            }
        }

    } catch (error) {
        // Ensure BlockhashManager is cleaned up on any error
        BlockhashManager.getInstance().cleanup();
        displayError('Sell failed!', error);
    }
}