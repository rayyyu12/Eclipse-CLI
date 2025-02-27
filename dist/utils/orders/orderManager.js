"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.OrderManager = void 0;
//ordermanager.ts
const web3_js_1 = require("@solana/web3.js");
const events_1 = require("events");
class OrderManager extends events_1.EventEmitter {
    constructor() {
        super();
        this.orders = new Map();
        this.priceSubscriptions = new Map();
        this.connection = null;
    }
    static getInstance() {
        if (!OrderManager.instance) {
            OrderManager.instance = new OrderManager();
        }
        return OrderManager.instance;
    }
    initialize(connection) {
        this.connection = connection;
    }
    async placeStopLoss(tokenAddress, stopPrice, quantity, walletAddress) {
        const orderId = `${tokenAddress}-${Date.now()}`;
        const order = {
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
    async placeLimitOrder(tokenAddress, limitPrice, quantity, walletAddress) {
        const orderId = `${tokenAddress}-${Date.now()}`;
        const order = {
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
    cancelOrder(orderId) {
        const order = this.orders.get(orderId);
        if (!order)
            return false;
        order.status = 'CANCELLED';
        this.orders.set(orderId, order);
        this.checkAndStopMonitoring(order.tokenAddress);
        return true;
    }
    async startMonitoringPrice(tokenAddress) {
        if (!this.connection)
            throw new Error("Connection not initialized");
        if (this.priceSubscriptions.has(tokenAddress)) {
            return; // Already monitoring this token
        }
        // Subscribe to account changes
        const tokenPubKey = new web3_js_1.PublicKey(tokenAddress);
        const subscriptionId = this.connection.onAccountChange(tokenPubKey, async () => {
            await this.checkPriceConditions(tokenAddress);
        });
        this.priceSubscriptions.set(tokenAddress, subscriptionId);
    }
    async checkPriceConditions(tokenAddress) {
        // Implement price checking logic here
        // This will be implemented in the next step
    }
    checkAndStopMonitoring(tokenAddress) {
        const hasActiveOrders = Array.from(this.orders.values()).some(order => order.tokenAddress === tokenAddress && order.status === 'PENDING');
        if (!hasActiveOrders && this.priceSubscriptions.has(tokenAddress)) {
            const subscriptionId = this.priceSubscriptions.get(tokenAddress);
            this.connection?.removeAccountChangeListener(subscriptionId);
            this.priceSubscriptions.delete(tokenAddress);
        }
    }
    getActiveOrders() {
        return Array.from(this.orders.values())
            .filter(order => order.status === 'PENDING');
    }
    getOrderById(orderId) {
        return this.orders.get(orderId);
    }
}
exports.OrderManager = OrderManager;
