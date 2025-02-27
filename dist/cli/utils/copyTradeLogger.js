"use strict";
// src/cli/utils/copyTradeLogger.ts
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CopyTradeLogger = void 0;
const chalk_1 = __importDefault(require("chalk"));
const config_1 = require("../config");
const events_1 = require("events");
class CopyTradeLogger extends events_1.EventEmitter {
    constructor() {
        super();
        this.logs = [];
        this.maxLogs = 1000;
    }
    static getInstance() {
        if (!CopyTradeLogger.instance) {
            CopyTradeLogger.instance = new CopyTradeLogger();
        }
        return CopyTradeLogger.instance;
    }
    addLog(log) {
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
    getLogs(count) {
        if (count) {
            return this.logs.slice(-count);
        }
        return [...this.logs];
    }
    clearLogs() {
        this.logs = [];
        this.emit('logsCleared');
    }
    formatLog(log) {
        const timestamp = log.timestamp.toLocaleString();
        const type = log.type.toUpperCase();
        let color;
        switch (log.type) {
            case 'success':
                color = config_1.COLORS.SUCCESS;
                break;
            case 'error':
                color = config_1.COLORS.ERROR;
                break;
            default:
                color = config_1.COLORS.ACCENT;
        }
        return `${chalk_1.default.hex(config_1.COLORS.SECONDARY)(timestamp)} [${chalk_1.default.hex(color)(type)}] ${chalk_1.default.hex(config_1.COLORS.PRIMARY)(log.protocol)}: ${chalk_1.default.hex(config_1.COLORS.ACCENT)(log.message)}`;
    }
}
exports.CopyTradeLogger = CopyTradeLogger;
