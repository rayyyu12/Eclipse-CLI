import { Connection, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddress, getAccount } from "@solana/spl-token";
import { PortfolioTracker } from './portfolioTracker';

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
                currentBalance = Number(accountInfo.amount) / Math.pow(10, 6); // Assuming 6 decimals
            } catch (error) {
                // Token account doesn't exist or other error
                currentBalance = 0;
            }

            // Get last known balance
            const lastBalance = this.lastKnownBalances.get(tokenAddress) || currentBalance;

            // If balance changed, update the position
            if (currentBalance !== lastBalance) {
                const balanceChange = currentBalance - lastBalance;
                if (balanceChange < 0) {
                    // Token amount decreased - handle as a sell
                    const currentPrice = await this.tracker.getCurrentTokenPrice(tokenAddress);
                    const solValue = Math.abs(balanceChange * currentPrice);
                    
                    await this.tracker.addPosition(
                        tokenAddress,
                        solValue, // Positive SOL received
                        balanceChange, // Negative token amount
                        'external-transaction',
                        {
                            entryPriceOverride: currentPrice
                        }
                    );
                }

                // Update last known balance
                this.lastKnownBalances.set(tokenAddress, currentBalance);
            }
        } catch (error) {
            console.error(`Error updating token balance for ${tokenAddress}:`, error);
        }
    }

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

    public async startMonitoring(
        connection: Connection, 
        walletPublicKey: PublicKey,
        tokenAddress: string
    ): Promise<void> {
        // Remove existing subscription if any
        this.stopMonitoring(tokenAddress);

        const tokenMint = new PublicKey(tokenAddress);
        const tokenAccount = await getAssociatedTokenAddress(tokenMint, walletPublicKey);

        // Set up account subscription
        const subscriptionId = connection.onAccountChange(
            tokenAccount,
            async (accountInfo) => {
                await this.updateTokenBalance(connection, walletPublicKey, tokenAddress);
            },
            'confirmed'
        );

        // Store subscription
        this.subscriptions.set(tokenAddress, subscriptionId);
        console.log(`Started monitoring ${tokenAddress}`);
    }

    public stopMonitoring(tokenAddress: string): void {
        const subscriptionId = this.subscriptions.get(tokenAddress);
        if (subscriptionId !== undefined) {
            // Remove the subscription
            this.subscriptions.delete(tokenAddress);
            console.log(`Stopped monitoring ${tokenAddress}`);
        }
    }

    public async stopAllMonitoring(): Promise<void> {
        for (const tokenAddress of this.subscriptions.keys()) {
            this.stopMonitoring(tokenAddress);
        }
        this.subscriptions.clear();
    }
}