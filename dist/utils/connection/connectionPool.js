"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.connectionPool = exports.ConnectionPool = void 0;
// src/utils/connection/connectionPool.ts
const web3_js_1 = require("@solana/web3.js");
const credentialsManager_1 = require("../../cli/utils/credentialsManager");
const logger_1 = require("../../cli/utils/logger");
/**
 * Manages a pool of Solana RPC connections to distribute load
 * and provide more resilient connection handling
 */
class ConnectionPool {
    constructor() {
        this.connections = [];
        this.roundRobinIndex = 0;
        this.logger = logger_1.Logger.getInstance();
        this.isInitialized = false;
        this.failedConnectionAttempts = new Map();
        this.connectionHealth = new Map();
        this.healthCheckInterval = null;
        this.lastSuccessfulConnection = null;
        this.credManager = credentialsManager_1.CredentialsManager.getInstance();
    }
    static getInstance() {
        if (!ConnectionPool.instance) {
            ConnectionPool.instance = new ConnectionPool();
        }
        return ConnectionPool.instance;
    }
    /**
     * Initialize the connection pool with multiple RPC endpoints
     */
    initialize(options = {}) {
        if (this.isInitialized)
            return;
        try {
            // First try to get from credentials manager
            const primaryRpcUrl = options.primaryRpcUrl || this.credManager.getRpcUrl();
            // Create primary connection
            const primaryConnection = new web3_js_1.Connection(primaryRpcUrl, {
                commitment: options.commitment || 'confirmed',
                confirmTransactionInitialTimeout: 60000
            });
            this.connections.push(primaryConnection);
            this.connectionHealth.set(primaryRpcUrl, true);
            this.lastSuccessfulConnection = primaryConnection;
            // Add fallback connections if provided
            if (options.fallbackRpcUrls && options.fallbackRpcUrls.length > 0) {
                for (const fallbackUrl of options.fallbackRpcUrls) {
                    if (fallbackUrl !== primaryRpcUrl) {
                        const fallbackConnection = new web3_js_1.Connection(fallbackUrl, {
                            commitment: options.commitment || 'confirmed',
                            confirmTransactionInitialTimeout: 60000
                        });
                        this.connections.push(fallbackConnection);
                        this.connectionHealth.set(fallbackUrl, true);
                    }
                }
            }
            this.logger.info('ConnectionPool', `Initialized with ${this.connections.length} connections`);
            this.startHealthCheck();
            this.isInitialized = true;
        }
        catch (error) {
            this.logger.error('ConnectionPool', 'Failed to initialize connection pool', error);
            throw error;
        }
    }
    /**
     * Start periodic health checks on connections
     */
    startHealthCheck() {
        if (this.healthCheckInterval) {
            clearInterval(this.healthCheckInterval);
        }
        this.healthCheckInterval = setInterval(() => {
            this.checkConnectionHealth();
        }, 30000); // Check every 30 seconds
    }
    /**
     * Check the health of all connections
     */
    async checkConnectionHealth() {
        let hasHealthyConnection = false;
        for (let i = 0; i < this.connections.length; i++) {
            const connection = this.connections[i];
            try {
                const endpoint = connection.rpcEndpoint;
                const startTime = Date.now();
                await connection.getLatestBlockhash();
                const responseTime = Date.now() - startTime;
                this.connectionHealth.set(endpoint, true);
                this.failedConnectionAttempts.set(endpoint, 0);
                this.lastSuccessfulConnection = connection;
                hasHealthyConnection = true;
                this.logger.debug('ConnectionPool', `Connection ${i + 1} health check passed in ${responseTime}ms`);
            }
            catch (error) {
                const endpoint = connection.rpcEndpoint;
                const failCount = (this.failedConnectionAttempts.get(endpoint) || 0) + 1;
                this.failedConnectionAttempts.set(endpoint, failCount);
                if (failCount >= 3) {
                    this.connectionHealth.set(endpoint, false);
                }
                this.logger.warn('ConnectionPool', `Connection ${i + 1} health check failed`, error);
            }
        }
        // If all connections are unhealthy but we had a successful one previously,
        // reset the health status of that one to try it again
        if (!hasHealthyConnection && this.lastSuccessfulConnection) {
            const endpoint = this.lastSuccessfulConnection.rpcEndpoint;
            this.connectionHealth.set(endpoint, true);
            this.failedConnectionAttempts.set(endpoint, 0);
            this.logger.warn('ConnectionPool', 'All connections unhealthy, resetting last successful connection');
        }
    }
    /**
     * Get the next healthy connection using round-robin algorithm
     */
    getConnection() {
        if (!this.isInitialized) {
            this.initialize();
        }
        if (this.connections.length === 0) {
            throw new Error('No connections available in the pool');
        }
        // Quickly check if we have at least one healthy connection
        const hasHealthyConn = Array.from(this.connectionHealth.values()).some(isHealthy => isHealthy);
        // If no healthy connections, reset health status and try again
        if (!hasHealthyConn) {
            this.logger.warn('ConnectionPool', 'No healthy connections found, resetting health status');
            for (const endpoint of this.connectionHealth.keys()) {
                this.connectionHealth.set(endpoint, true);
                this.failedConnectionAttempts.set(endpoint, 0);
            }
        }
        // Find next healthy connection
        let checkedConnections = 0;
        let selectedConnection = null;
        while (checkedConnections < this.connections.length) {
            this.roundRobinIndex = (this.roundRobinIndex + 1) % this.connections.length;
            const connection = this.connections[this.roundRobinIndex];
            const isHealthy = this.connectionHealth.get(connection.rpcEndpoint) !== false;
            if (isHealthy) {
                selectedConnection = connection;
                break;
            }
            checkedConnections++;
        }
        // If we found a healthy connection, use it
        if (selectedConnection) {
            return selectedConnection;
        }
        // If we have a last successful connection, try that one
        if (this.lastSuccessfulConnection) {
            this.logger.warn('ConnectionPool', 'Using last successful connection as fallback');
            return this.lastSuccessfulConnection;
        }
        // As a last resort, return the first connection
        this.logger.warn('ConnectionPool', 'No healthy connections found, using first connection');
        return this.connections[0];
    }
    /**
     * Get all connections
     */
    getAllConnections() {
        if (!this.isInitialized) {
            this.initialize();
        }
        return [...this.connections];
    }
    /**
     * Clean up connections and intervals
     */
    cleanup() {
        if (this.healthCheckInterval) {
            clearInterval(this.healthCheckInterval);
            this.healthCheckInterval = null;
        }
        this.logger.info('ConnectionPool', 'Connection pool cleaned up');
    }
}
exports.ConnectionPool = ConnectionPool;
exports.connectionPool = ConnectionPool.getInstance();
