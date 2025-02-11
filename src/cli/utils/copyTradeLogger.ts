// src/cli/utils/copyTradeLogger.ts

import chalk from 'chalk';
import { COLORS } from '../config';
import { EventEmitter } from 'events';

export interface CopyTradeLog {
    timestamp: Date;
    type: 'info' | 'success' | 'error';
    protocol: string;
    message: string;
    details?: Record<string, any>;
}

export class CopyTradeLogger extends EventEmitter {
    private static instance: CopyTradeLogger;
    private logs: CopyTradeLog[] = [];
    private readonly maxLogs: number = 1000;

    private constructor() {
        super();
    }

    public static getInstance(): CopyTradeLogger {
        if (!CopyTradeLogger.instance) {
            CopyTradeLogger.instance = new CopyTradeLogger();
        }
        return CopyTradeLogger.instance;
    }

    public addLog(log: Omit<CopyTradeLog, 'timestamp'>): void {
        const fullLog = {
            ...log,
            timestamp: new Date()
        };
        
        this.logs.push(fullLog);

        // Keep only the last maxLogs entries
        if (this.logs.length > this.maxLogs) {
            this.logs = this.logs.slice(-this.maxLogs);
        }

        // Emit event for new log
        this.emit('newLog', fullLog);
    }

    public getLogs(count?: number): CopyTradeLog[] {
        if (count) {
            return this.logs.slice(-count);
        }
        return [...this.logs];
    }

    public clearLogs(): void {
        this.logs = [];
        this.emit('logsCleared');
    }

    public formatLog(log: CopyTradeLog): string {
        const timestamp = log.timestamp.toLocaleString();
        const type = log.type.toUpperCase();
        let color: string;

        switch (log.type) {
            case 'success':
                color = COLORS.SUCCESS;
                break;
            case 'error':
                color = COLORS.ERROR;
                break;
            default:
                color = COLORS.ACCENT;
        }

        return `${chalk.hex(COLORS.SECONDARY)(timestamp)} [${chalk.hex(color)(type)}] ${chalk.hex(COLORS.PRIMARY)(log.protocol)}: ${chalk.hex(COLORS.ACCENT)(log.message)}`;
    }
}