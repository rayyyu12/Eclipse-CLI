//tokenBalanceMonitor.ts
import { Connection, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddress, getAccount } from "@solana/spl-token";
import chalk from "chalk";
import { COLORS } from "../../cli/config";
import { PortfolioTracker } from "./portfolioTracker";
import { ImageGenerator } from "./imageGenerator";

export class TokenBalanceMonitor {
    private static instance: TokenBalanceMonitor;
    private lastKnownBalances: Map<string, number>;
    private tracker: PortfolioTracker;
    private subscriptions: Map<string, number>;

    private constructor() {
        this.lastKnownBalances = new Map();
        this.tracker = PortfolioTracker.getInstance();
        this.subscriptions = new Map();
    }

    public static getInstance(): TokenBalanceMonitor {
        if (!TokenBalanceMonitor.instance) {
            TokenBalanceMonitor.instance = new TokenBalanceMonitor();
        }
        return TokenBalanceMonitor.instance;
    }

    /**
     * Update the balance for a given token by direct fetch.
     * Called both on account subscription changes and when explicitly requested (e.g. post-sell).
     */
    public async updateTokenBalance(
        connection: Connection,
        walletPublicKey: PublicKey,
        tokenAddress: string
    ): Promise<void> {
        try {
            const tokenMint = new PublicKey(tokenAddress);
            const tokenAccount = await getAssociatedTokenAddress(tokenMint, walletPublicKey);

            // Get current token balance
            let currentBalance = 0;
            try {
                const accountInfo = await getAccount(connection, tokenAccount);
                // If your tokens have a different number of decimals, adjust below:
                currentBalance = Number(accountInfo.amount) / Math.pow(10, 6);
            } catch {
                // If token account doesn't exist, set balance to 0
                currentBalance = 0;
            }

            // Track last known balance to detect changes
            const lastBalance = this.lastKnownBalances.get(tokenAddress) ?? 0;

            // If balance changes, process the transaction
            if (currentBalance !== lastBalance) {
                const balanceChange = currentBalance - lastBalance;

                if (balanceChange > 0) {
                    // Token amount increased (buy)
                    await this.tracker.addPosition(
                        tokenAddress,
                        balanceChange, // SOL or equivalent spent
                        balanceChange, // Tokens added
                        'external-transaction',
                        {
                            entryPriceOverride: await this.tracker.getCurrentTokenPrice(tokenAddress),
                        }
                    );
                } else {
                    // Token amount decreased (sell)
                    const currentPrice = await this.tracker.getCurrentTokenPrice(tokenAddress);
                    const solValue = Math.abs(balanceChange) * currentPrice;

                    await this.tracker.addPosition(
                        tokenAddress,
                        solValue,     // SOL gained
                        balanceChange, 
                        'external-transaction',
                        {
                            entryPriceOverride: currentPrice,
                        }
                    );
                }

                // Update last known
                this.lastKnownBalances.set(tokenAddress, currentBalance);
            }
        } catch (error) {
            console.error(`Error updating token balance for ${tokenAddress}:`, error);
        }
    }

    /**
     * Check all tracked positions, update their balances.
     */
    public async monitorAllPositions(
        connection: Connection,
        walletPublicKey: PublicKey
    ): Promise<void> {
        const positions = await this.tracker.getAllPositions();
        for (const position of positions.positions) {
            await this.updateTokenBalance(
                connection,
                walletPublicKey,
                position.tokenAddress
            );
        }
    }

    /**
     * Begin monitoring a token in real-time (via onAccountChange).
     * If already subscribed, does nothing.
     */
    public async startMonitoring(
        connection: Connection, 
        walletPublicKey: PublicKey,
        tokenAddress: string
    ): Promise<void> {
        if (this.subscriptions.has(tokenAddress)) {
            return;
        }
    
        const tokenMint = new PublicKey(tokenAddress);
        const tokenAccount = await getAssociatedTokenAddress(tokenMint, walletPublicKey);
    
        const subscriptionId = connection.onAccountChange(
            tokenAccount,
            async () => {
                await this.updateTokenBalance(connection, walletPublicKey, tokenAddress)
                    .catch(err => {
                        if (!(err instanceof Error) || !err.message.includes('429')) {
                            console.error(`Error updating balance for ${tokenAddress}`);
                        }
                    });
            },
            'confirmed'
        );
    
        this.subscriptions.set(tokenAddress, subscriptionId);
    }

    /**
     * Stop monitoring a specific token
     */
    public stopMonitoring(tokenAddress: string): void {
        const subscriptionId = this.subscriptions.get(tokenAddress);
        if (subscriptionId !== undefined) {
            // You can call removeAccountChangeListener here if you want,
            // but that depends on how your Connection object is managed.
            this.subscriptions.delete(tokenAddress);
        }
    }

    /**
     * Stop monitoring all tokens
     */
    public async stopAllMonitoring(): Promise<void> {
        for (const tokenAddress of this.subscriptions.keys()) {
            this.stopMonitoring(tokenAddress);
        }
        this.subscriptions.clear();
    }

    /**
     * CALL THIS after you confirm a sell transaction completes on-chain.
     *  1) If no monitoring is active, it starts monitoring.
     *  2) Forces a balance update, ensuring the position data is fresh.
     *  3) Generates a Discord image to reflect the updated position data.
     */
    public async handleConfirmedSellTransaction(
        connection: Connection,
        walletPublicKey: PublicKey,
        tokenAddress: string
    ): Promise<void> {
        // 1) Ensure monitoring is active
        if (!this.subscriptions.has(tokenAddress)) {
            await this.startMonitoring(connection, walletPublicKey, tokenAddress);
        }

        // 2) Immediately fetch the updated balance
        await this.updateTokenBalance(connection, walletPublicKey, tokenAddress);

        // 3) Generate and send the updated position image
        const positionData = await this.tracker.getPosition(tokenAddress);
        if (positionData) {
            const imageGen = ImageGenerator.getInstance();
            const imageBuffer = await imageGen.generatePositionImage(positionData);
            await imageGen.sendToDiscord(imageBuffer, positionData);
        }
    }
}