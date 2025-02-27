"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.logger = exports.Logger = exports.LogLevel = void 0;
// src/cli/utils/logger.ts
const chalk_1 = __importDefault(require("chalk"));
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const config_1 = require("../config");
var LogLevel;
(function (LogLevel) {
    LogLevel[LogLevel["DEBUG"] = 0] = "DEBUG";
    LogLevel[LogLevel["INFO"] = 1] = "INFO";
    LogLevel[LogLevel["SUCCESS"] = 2] = "SUCCESS";
    LogLevel[LogLevel["WARN"] = 3] = "WARN";
    LogLevel[LogLevel["ERROR"] = 4] = "ERROR";
    LogLevel[LogLevel["SILENT"] = 5] = "SILENT";
})(LogLevel || (exports.LogLevel = LogLevel = {}));
/**
 * Centralized logger for the application that supports console output
 * and file logging with configurable log levels.
 */
class Logger {
    constructor() {
        this.logLevel = LogLevel.INFO;
        this.logs = [];
        this.maxLogSize = 10 * 1024 * 1024; // 10MB
        this.isLoggingToFile = false;
        this.isInitialized = false;
        this.isLoggingToConsole = true;
        this.logDir = path_1.default.join(process.cwd(), 'logs');
        this.logFile = path_1.default.join(this.logDir, `eclipse-${new Date().toISOString().split('T')[0]}.log`);
    }
    static getInstance() {
        if (!Logger.instance) {
            Logger.instance = new Logger();
        }
        return Logger.instance;
    }
    /**
     * Initialize the logger with the specified options
     */
    initialize(options = {}) {
        if (this.isInitialized)
            return;
        // Apply options
        if (options.logLevel !== undefined)
            this.logLevel = options.logLevel;
        if (options.logToFile !== undefined)
            this.isLoggingToFile = options.logToFile;
        if (options.logToConsole !== undefined)
            this.isLoggingToConsole = options.logToConsole;
        if (options.logDir)
            this.logDir = options.logDir;
        if (options.maxLogSize)
            this.maxLogSize = options.maxLogSize;
        // Update log file path
        this.logFile = path_1.default.join(this.logDir, `eclipse-${new Date().toISOString().split('T')[0]}.log`);
        // Create log directory if it doesn't exist
        if (this.isLoggingToFile && !fs_1.default.existsSync(this.logDir)) {
            fs_1.default.mkdirSync(this.logDir, { recursive: true });
        }
        this.isInitialized = true;
    }
    /**
     * Set the current log level
     */
    setLogLevel(level) {
        this.logLevel = level;
    }
    /**
     * Enable or disable file logging
     */
    setFileLogging(enabled) {
        this.isLoggingToFile = enabled;
        if (enabled && !fs_1.default.existsSync(this.logDir)) {
            fs_1.default.mkdirSync(this.logDir, { recursive: true });
        }
    }
    /**
     * Enable or disable console logging
     */
    setConsoleLogging(enabled) {
        this.isLoggingToConsole = enabled;
    }
    /**
     * Log a message at the specified level
     */
    log(level, module, message, data) {
        if (level < this.logLevel)
            return;
        const entry = {
            timestamp: new Date(),
            level,
            module,
            message,
            data
        };
        this.logs.push(entry);
        // Limit in-memory logs
        if (this.logs.length > 1000) {
            this.logs = this.logs.slice(-1000);
        }
        // Console output if not silent and console logging is enabled
        if (level >= this.logLevel && level !== LogLevel.SILENT && this.isLoggingToConsole) {
            const timestamp = entry.timestamp.toLocaleTimeString();
            let levelString;
            let colorFunc;
            switch (level) {
                case LogLevel.DEBUG:
                    levelString = 'DEBUG';
                    colorFunc = chalk_1.default.gray;
                    break;
                case LogLevel.INFO:
                    levelString = 'INFO';
                    colorFunc = chalk_1.default.hex(config_1.COLORS.PRIMARY);
                    break;
                case LogLevel.SUCCESS:
                    levelString = 'SUCCESS';
                    colorFunc = chalk_1.default.hex(config_1.COLORS.SUCCESS);
                    break;
                case LogLevel.WARN:
                    levelString = 'WARN';
                    colorFunc = chalk_1.default.hex(config_1.COLORS.ACCENT);
                    break;
                case LogLevel.ERROR:
                    levelString = 'ERROR';
                    colorFunc = chalk_1.default.hex(config_1.COLORS.ERROR);
                    break;
                default:
                    levelString = 'UNKNOWN';
                    colorFunc = chalk_1.default.white;
            }
            const formattedModule = module ? `[${module}]` : '';
            console.log(`${chalk_1.default.gray(timestamp)} ${colorFunc(levelString)} ${chalk_1.default.hex(config_1.COLORS.SECONDARY)(formattedModule)} ${colorFunc(message)}`);
            if (data && level === LogLevel.DEBUG) {
                console.log(chalk_1.default.gray(JSON.stringify(data, null, 2)));
            }
        }
        // File logging if enabled
        if (this.isLoggingToFile) {
            this.writeToFile(entry);
        }
    }
    /**
     * Write a log entry to the log file
     */
    writeToFile(entry) {
        if (!this.isLoggingToFile)
            return;
        try {
            // Check if log file is too big
            if (fs_1.default.existsSync(this.logFile)) {
                const stats = fs_1.default.statSync(this.logFile);
                if (stats.size > this.maxLogSize) {
                    // Rotate logs
                    const timestamp = new Date().toISOString().replace(/:/g, '-');
                    const newLogFile = path_1.default.join(this.logDir, `eclipse-${timestamp}.log`);
                    fs_1.default.renameSync(this.logFile, newLogFile);
                }
            }
            // Format log entry
            const levelString = LogLevel[entry.level];
            const message = `${entry.timestamp.toISOString()} ${levelString} ${entry.module ? `[${entry.module}] ` : ''}${entry.message}`;
            const logLine = entry.data ? `${message}\n${JSON.stringify(entry.data, null, 2)}` : message;
            // Append to log file
            fs_1.default.appendFileSync(this.logFile, logLine + '\n');
        }
        catch (error) {
            // Only log to console if console logging is enabled
            if (this.isLoggingToConsole) {
                console.error(`Failed to write to log file: ${error}`);
            }
            // Disable file logging if it fails
            this.isLoggingToFile = false;
        }
    }
    /**
     * Log a debug message
     */
    debug(module, message, data) {
        this.log(LogLevel.DEBUG, module, message, data);
    }
    /**
     * Log an info message
     */
    info(module, message, data) {
        this.log(LogLevel.INFO, module, message, data);
    }
    /**
     * Log a success message
     */
    success(module, message, data) {
        this.log(LogLevel.SUCCESS, module, message, data);
    }
    /**
     * Log a warning message
     */
    warn(module, message, data) {
        this.log(LogLevel.WARN, module, message, data);
    }
    /**
     * Log an error message
     */
    error(module, message, data) {
        this.log(LogLevel.ERROR, module, message, data);
    }
    /**
     * Get recent logs
     */
    getLogs(count) {
        if (count) {
            return this.logs.slice(-count);
        }
        return [...this.logs];
    }
    /**
     * Clear logs
     */
    clearLogs() {
        this.logs = [];
    }
}
exports.Logger = Logger;
exports.logger = Logger.getInstance();
