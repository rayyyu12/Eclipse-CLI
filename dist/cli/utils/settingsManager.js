"use strict";
// src/cli/utils/settingsManager.ts
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SettingsManager = void 0;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const settings_1 = require("../types/settings");
class SettingsManager {
    constructor() {
        this.settingsPath = path_1.default.join(process.cwd(), 'settings.json');
        this.settings = this.loadSettings();
    }
    static getInstance() {
        if (!SettingsManager.instance) {
            SettingsManager.instance = new SettingsManager();
        }
        return SettingsManager.instance;
    }
    loadSettings() {
        try {
            if (fs_1.default.existsSync(this.settingsPath)) {
                const fileContent = fs_1.default.readFileSync(this.settingsPath, 'utf-8');
                return { ...settings_1.DEFAULT_SETTINGS, ...JSON.parse(fileContent) };
            }
        }
        catch (error) {
            console.error('Error loading settings:', error);
        }
        return { ...settings_1.DEFAULT_SETTINGS };
    }
    saveSettings() {
        try {
            fs_1.default.writeFileSync(this.settingsPath, JSON.stringify(this.settings, null, 2));
        }
        catch (error) {
            console.error('Error saving settings:', error);
        }
    }
    getSettings() {
        return { ...this.settings };
    }
    updateSettings(newSettings) {
        this.settings = {
            ...this.settings,
            ...newSettings
        };
        this.saveSettings();
    }
    updateFeeSettings(feeSettings) {
        this.settings.fees = {
            ...this.settings.fees,
            ...feeSettings
        };
        this.saveSettings();
    }
    updateConnectionSettings(connectionSettings) {
        this.settings.connection = {
            ...this.settings.connection,
            ...connectionSettings
        };
        this.saveSettings();
    }
    updateNotificationSettings(notificationSettings) {
        this.settings.notifications = {
            ...this.settings.notifications,
            ...notificationSettings
        };
        this.saveSettings();
    }
}
exports.SettingsManager = SettingsManager;
