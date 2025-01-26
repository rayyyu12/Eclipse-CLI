import { PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { setupConnection } from '../../index';
import { swapSolToToken } from '../../utils/swaps/regularSwap';
import { swapSolToPumpToken, isPumpFunToken } from '../../utils/swaps/pumpSwap';
import { validatePublicKey, validateSolAmount } from '../utils/validation';
import { promptWithValidation, spinner, displayError, displaySuccess } from '../utils/formatting';
import { TokenTypeCache } from '../../utils/pools/tokenTypeCache';
import { getAssociatedTokenAddress, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import chalk from 'chalk';
import { PortfolioTracker } from '../../utils/positions/portfolioTracker';
import { BlockhashManager } from '../../utils/swaps/blockhashManager';
import { COLORS } from '../config';

export async function handleBuy(): Promise<void> {
    try {
        const tokenAddress = await promptWithValidation(
            chalk.hex(COLORS.PRIMARY)('Enter token address: '),
            validatePublicKey,
            'Invalid token address format!'
        );

        const solAmount = await promptWithValidation(
            (chalk.hex(COLORS.PRIMARY)('Enter SOL amount: ')),
            validateSolAmount,
            'Invalid SOL amount! Please enter a positive number.'
        );

        const tokenPublicKey = new PublicKey(tokenAddress);
        spinner.start('Checking token type...');

        const { connection, wallet } = await setupConnection();
        
        // Initialize BlockhashManager before any swap operations
        BlockhashManager.getInstance().initialize(connection);

        // Check if it's a pump.fun token
        let tokenInfo;
        try {
            tokenInfo = await isPumpFunToken(connection, tokenPublicKey);
        } catch (error) {
            BlockhashManager.getInstance().cleanup(); // Cleanup on error
            displayError('Failed to check token type', error);
            return;
        }

        const amount = parseFloat(solAmount);

        // Add additional validation before swap
        const solBalance = await connection.getBalance(wallet.publicKey);
        if (solBalance < amount * LAMPORTS_PER_SOL + 0.01 * LAMPORTS_PER_SOL) {
            BlockhashManager.getInstance().cleanup(); // Cleanup on validation failure
            displayError('Insufficient SOL balance', 
                new Error(`Need ${amount + 0.01} SOL, but only have ${solBalance / LAMPORTS_PER_SOL} SOL`));
            return;
        }

        let signature: string;
        
        if (tokenInfo.isPump) {
            spinner.text = 'Using pump.fun swap mechanism...';
            signature = await swapSolToPumpToken(
                connection,
                wallet,
                tokenPublicKey,
                amount,
                0.01
            );
        } else {
            spinner.text = tokenInfo.hasMigrated ? 
                'Using regular swap for migrated pump token...' : 
                'Using regular swap...';
            
            signature = await swapSolToToken(
                connection,
                wallet,
                tokenPublicKey,
                amount * LAMPORTS_PER_SOL,
                0.01
            );
        }

        // Cleanup BlockhashManager after successful swap
        BlockhashManager.getInstance().cleanup();

        displaySuccess('Buy successful!');
        console.log(chalk.hex(COLORS.SUCCESS)("\nTransaction Details:"));
        console.log("Signature:", chalk.hex(COLORS.PRIMARY)(signature));
        console.log("Explorer:", chalk.hex(COLORS.PRIMARY)(`https://solscan.io/tx/${signature}`));

    } catch (error) {
        // Ensure BlockhashManager is cleaned up on any error
        BlockhashManager.getInstance().cleanup();
        displayError('Buy failed!', error);
    }
}