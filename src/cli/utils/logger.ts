// src/cli/utils/logger.ts
import chalk from 'chalk';
import fs from 'fs';
import path from 'path';
import { COLORS } from '../config';

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  SUCCESS = 2,
  WARN = 3,
  ERROR = 4,
  SILENT = 5
}

interface LogEntry {
  timestamp: Date;
  level: LogLevel;
  module: string;
  message: string;
  data?: any;
}

/**
 * Centralized logger for the application that supports console output
 * and file logging with configurable log levels.
 */
export class Logger {
  private static instance: Logger;
  private logLevel: LogLevel = LogLevel.INFO;
  private logs: LogEntry[] = [];
  private logDir: string;
  private logFile: string;
  private maxLogSize: number = 10 * 1024 * 1024; // 10MB
  private isLoggingToFile: boolean = false;
  private isInitialized: boolean = false;
  private isLoggingToConsole: boolean = true;

  private constructor() {
    this.logDir = path.join(process.cwd(), 'logs');
    this.logFile = path.join(this.logDir, `eclipse-${new Date().toISOString().split('T')[0]}.log`);
  }

  public static getInstance(): Logger {
    if (!Logger.instance) {
      Logger.instance = new Logger();
    }
    return Logger.instance;
  }

  /**
   * Initialize the logger with the specified options
   */
  public initialize(options: {
    logLevel?: LogLevel;
    logToFile?: boolean;
    logToConsole?: boolean;
    logDir?: string;
    maxLogSize?: number;
  } = {}): void {
    if (this.isInitialized) return;

    // Apply options
    if (options.logLevel !== undefined) this.logLevel = options.logLevel;
    if (options.logToFile !== undefined) this.isLoggingToFile = options.logToFile;
    if (options.logToConsole !== undefined) this.isLoggingToConsole = options.logToConsole;
    if (options.logDir) this.logDir = options.logDir;
    if (options.maxLogSize) this.maxLogSize = options.maxLogSize;

    // Update log file path
    this.logFile = path.join(this.logDir, `eclipse-${new Date().toISOString().split('T')[0]}.log`);

    // Create log directory if it doesn't exist
    if (this.isLoggingToFile && !fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }

    this.isInitialized = true;
  }

  /**
   * Set the current log level
   */
  public setLogLevel(level: LogLevel): void {
    this.logLevel = level;
  }

  /**
   * Enable or disable file logging
   */
  public setFileLogging(enabled: boolean): void {
    this.isLoggingToFile = enabled;
    if (enabled && !fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }
  }

  /**
   * Enable or disable console logging
   */
  public setConsoleLogging(enabled: boolean): void {
    this.isLoggingToConsole = enabled;
  }

  /**
   * Log a message at the specified level
   */
  private log(level: LogLevel, module: string, message: string, data?: any): void {
    if (level < this.logLevel) return;

    const entry: LogEntry = {
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
      let levelString: string;
      let colorFunc: Function;

      switch (level) {
        case LogLevel.DEBUG:
          levelString = 'DEBUG';
          colorFunc = chalk.gray;
          break;
        case LogLevel.INFO:
          levelString = 'INFO';
          colorFunc = chalk.hex(COLORS.PRIMARY);
          break;
        case LogLevel.SUCCESS:
          levelString = 'SUCCESS';
          colorFunc = chalk.hex(COLORS.SUCCESS);
          break;
        case LogLevel.WARN:
          levelString = 'WARN';
          colorFunc = chalk.hex(COLORS.ACCENT);
          break;
        case LogLevel.ERROR:
          levelString = 'ERROR';
          colorFunc = chalk.hex(COLORS.ERROR);
          break;
        default:
          levelString = 'UNKNOWN';
          colorFunc = chalk.white;
      }

      const formattedModule = module ? `[${module}]` : '';
      console.log(`${chalk.gray(timestamp)} ${colorFunc(levelString)} ${chalk.hex(COLORS.SECONDARY)(formattedModule)} ${colorFunc(message)}`);
      
      if (data && level === LogLevel.DEBUG) {
        console.log(chalk.gray(JSON.stringify(data, null, 2)));
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
  private writeToFile(entry: LogEntry): void {
    if (!this.isLoggingToFile) return;

    try {
      // Check if log file is too big
      if (fs.existsSync(this.logFile)) {
        const stats = fs.statSync(this.logFile);
        if (stats.size > this.maxLogSize) {
          // Rotate logs
          const timestamp = new Date().toISOString().replace(/:/g, '-');
          const newLogFile = path.join(this.logDir, `eclipse-${timestamp}.log`);
          fs.renameSync(this.logFile, newLogFile);
        }
      }

      // Format log entry
      const levelString = LogLevel[entry.level];
      const message = `${entry.timestamp.toISOString()} ${levelString} ${entry.module ? `[${entry.module}] ` : ''}${entry.message}`;
      const logLine = entry.data ? `${message}\n${JSON.stringify(entry.data, null, 2)}` : message;

      // Append to log file
      fs.appendFileSync(this.logFile, logLine + '\n');
    } catch (error) {
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
  public debug(module: string, message: string, data?: any): void {
    this.log(LogLevel.DEBUG, module, message, data);
  }

  /**
   * Log an info message
   */
  public info(module: string, message: string, data?: any): void {
    this.log(LogLevel.INFO, module, message, data);
  }

  /**
   * Log a success message
   */
  public success(module: string, message: string, data?: any): void {
    this.log(LogLevel.SUCCESS, module, message, data);
  }

  /**
   * Log a warning message
   */
  public warn(module: string, message: string, data?: any): void {
    this.log(LogLevel.WARN, module, message, data);
  }

  /**
   * Log an error message
   */
  public error(module: string, message: string, data?: any): void {
    this.log(LogLevel.ERROR, module, message, data);
  }

  /**
   * Get recent logs
   */
  public getLogs(count?: number): LogEntry[] {
    if (count) {
      return this.logs.slice(-count);
    }
    return [...this.logs];
  }

  /**
   * Clear logs
   */
  public clearLogs(): void {
    this.logs = [];
  }
}

export const logger = Logger.getInstance();