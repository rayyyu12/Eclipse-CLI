//ordermanager.ts
import { Connection, PublicKey } from "@solana/web3.js";
import { EventEmitter } from 'events';

export interface Order {
    id: string;
    type: 'STOP_LOSS' | 'LIMIT';
    tokenAddress: string;
    targetPrice: number;
    quantity: number;
    status: 'PENDING' | 'EXECUTED' | 'CANCELLED';
    createdAt: number;
    walletAddress: string;
}

export class OrderManager extends EventEmitter {
    private static instance: OrderManager;
    private orders: Map<string, Order>;
    private priceSubscriptions: Map<string, number>;
    private connection: Connection | null;

    private constructor() {
        super();
        this.orders = new Map();
        this.priceSubscriptions = new Map();
        this.connection = null;
    }

    public static getInstance(): OrderManager {
        if (!OrderManager.instance) {
            OrderManager.instance = new OrderManager();
        }
        return OrderManager.instance;
    }

    public initialize(connection: Connection): void {
        this.connection = connection;
    }

    public async placeStopLoss(
        tokenAddress: string,
        stopPrice: number,
        quantity: number,
        walletAddress: string
    ): Promise<string> {
        const orderId = `${tokenAddress}-${Date.now()}`;
        
        const order: Order = {
            id: orderId,
            type: 'STOP_LOSS',
            tokenAddress,
            targetPrice: stopPrice,
            quantity,
            status: 'PENDING',
            createdAt: Date.now(),
            walletAddress
        };

        this.orders.set(orderId, order);
        await this.startMonitoringPrice(tokenAddress);
        
        return orderId;
    }

    public async placeLimitOrder(
        tokenAddress: string,
        limitPrice: number,
        quantity: number,
        walletAddress: string
    ): Promise<string> {
        const orderId = `${tokenAddress}-${Date.now()}`;
        
        const order: Order = {
            id: orderId,
            type: 'LIMIT',
            tokenAddress,
            targetPrice: limitPrice,
            quantity,
            status: 'PENDING',
            createdAt: Date.now(),
            walletAddress
        };

        this.orders.set(orderId, order);
        await this.startMonitoringPrice(tokenAddress);
        
        return orderId;
    }

    public cancelOrder(orderId: string): boolean {
        const order = this.orders.get(orderId);
        if (!order) return false;

        order.status = 'CANCELLED';
        this.orders.set(orderId, order);
        this.checkAndStopMonitoring(order.tokenAddress);
        return true;
    }

    private async startMonitoringPrice(tokenAddress: string): Promise<void> {
        if (!this.connection) throw new Error("Connection not initialized");
        
        if (this.priceSubscriptions.has(tokenAddress)) {
            return; // Already monitoring this token
        }

        // Subscribe to account changes
        const tokenPubKey = new PublicKey(tokenAddress);
        const subscriptionId = this.connection.onAccountChange(
            tokenPubKey,
            async () => {
                await this.checkPriceConditions(tokenAddress);
            }
        );

        this.priceSubscriptions.set(tokenAddress, subscriptionId);
    }

    private async checkPriceConditions(tokenAddress: string): Promise<void> {
        // Implement price checking logic here
        // This will be implemented in the next step
    }

    private checkAndStopMonitoring(tokenAddress: string): void {
        const hasActiveOrders = Array.from(this.orders.values()).some(
            order => order.tokenAddress === tokenAddress && order.status === 'PENDING'
        );

        if (!hasActiveOrders && this.priceSubscriptions.has(tokenAddress)) {
            const subscriptionId = this.priceSubscriptions.get(tokenAddress)!;
            this.connection?.removeAccountChangeListener(subscriptionId);
            this.priceSubscriptions.delete(tokenAddress);
        }
    }

    public getActiveOrders(): Order[] {
        return Array.from(this.orders.values())
            .filter(order => order.status === 'PENDING');
    }

    public getOrderById(orderId: string): Order | undefined {
        return this.orders.get(orderId);
    }
}
