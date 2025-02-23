//poolSelector.ts
import { Connection, PublicKey } from '@solana/web3.js';
import { PoolAccounts } from "../../types";
import BN from 'bn.js';
import { findAllPools } from './poolDiscovery';
import { LIQUIDITY_STATE_LAYOUT_V4 } from '@raydium-io/raydium-sdk';

export interface PoolQuote {
    pool: PoolAccounts;
    expectedOutput: BN;
    priceImpact: number;
}

async function calculateExpectedOutput(
    connection: Connection,
    pool: PoolAccounts,
    amountIn: BN
): Promise<{ expectedOutput: BN; priceImpact: number }> {
    try {
        // Get token balances from vaults
        const baseTokenAmount = await connection.getTokenAccountBalance(
            pool.poolCoinTokenAccount
        );
        const quoteTokenAmount = await connection.getTokenAccountBalance(
            pool.poolPcTokenAccount
        );

        if (!baseTokenAmount.value || !quoteTokenAmount.value) {
            throw new Error('Failed to fetch token balances');
        }

        const baseReserve = new BN(baseTokenAmount.value.amount);
        const quoteReserve = new BN(quoteTokenAmount.value.amount);

        // Constant product formula: k = x * y
        const k = baseReserve.mul(quoteReserve);
        
        // New base reserve after swap: x + dx
        const newBaseReserve = baseReserve.add(amountIn);
        
        // New quote reserve: k / (x + dx)
        const newQuoteReserve = k.div(newBaseReserve);
        
        // Expected output: y - (k / (x + dx))
        const expectedOutput = quoteReserve.sub(newQuoteReserve);

        // Calculate price impact
        const priceImpact = expectedOutput.toNumber() > 0 
            ? ((amountIn.toNumber() / baseReserve.toNumber()) * 100)
            : 0;

        return { 
            expectedOutput, 
            priceImpact: Math.abs(priceImpact)
        };
    } catch (error) {
        console.error('Error calculating expected output:', error);
        throw error;
    }
}

export async function getBestPool(
    connection: Connection,
    inputMint: PublicKey,
    outputMint: PublicKey,
    amountIn: BN
): Promise<PoolQuote> {
    try {
        // Get all pools for the input token
        const pools = await findAllPools(connection, inputMint);
        
        if (pools.length === 0) {
            throw new Error('No pools found for the input token');
        }

        // Filter pools that have the output token and calculate quotes
        const quotes = await Promise.all(
            pools.filter(pool => 
                pool.poolCoinTokenAccount.equals(outputMint) || 
                pool.poolPcTokenAccount.equals(outputMint)
            ).map(async pool => {
                try {
                    const { expectedOutput, priceImpact } = await calculateExpectedOutput(
                        connection,
                        pool,
                        amountIn
                    );

                    return {
                        pool,
                        expectedOutput,
                        priceImpact
                    };
                } catch (error) {
                    console.error(`Error calculating quote for pool ${pool.id}:`, error);
                    return null;
                }
            })
        );

        // Filter out failed quotes and sort by best price
        const validQuotes = quotes.filter((quote): quote is PoolQuote => 
            quote !== null && 
            quote.expectedOutput.gt(new BN(0))
        );

        if (validQuotes.length === 0) {
            throw new Error('No valid quotes found');
        }

        // Sort by highest output amount and lowest price impact
        return validQuotes.sort((a, b) => {
            const outputDiff = b.expectedOutput.sub(a.expectedOutput).toNumber();
            if (outputDiff !== 0) return outputDiff;
            return a.priceImpact - b.priceImpact;
        })[0];

    } catch (error) {
        console.error('Error in getBestPool:', error);
        throw error;
    }
}

export function formatAmount(amount: BN, decimals: number): string {
    const divisor = new BN(10).pow(new BN(decimals));
    const integerPart = amount.div(divisor);
    const fractionalPart = amount.mod(divisor);
    return `${integerPart.toString()}.${fractionalPart.toString().padStart(decimals, '0')}`;
}
