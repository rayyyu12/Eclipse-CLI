// src/cli/utils/settingsManager.ts

import fs from 'fs';
import path from 'path';
import { Settings, DEFAULT_SETTINGS } from '../types/settings';

export class SettingsManager {
    private static instance: SettingsManager;
    private settings: Settings;
    private readonly settingsPath: string;

    private constructor() {
        this.settingsPath = path.join(process.cwd(), 'settings.json');
        this.settings = this.loadSettings();
    }

    public static getInstance(): SettingsManager {
        if (!SettingsManager.instance) {
            SettingsManager.instance = new SettingsManager();
        }
        return SettingsManager.instance;
    }

    private loadSettings(): Settings {
        try {
            if (fs.existsSync(this.settingsPath)) {
                const fileContent = fs.readFileSync(this.settingsPath, 'utf-8');
                return { ...DEFAULT_SETTINGS, ...JSON.parse(fileContent) };
            }
        } catch (error) {
            console.error('Error loading settings:', error);
        }
        return { ...DEFAULT_SETTINGS };
    }

    private saveSettings(): void {
        try {
            fs.writeFileSync(this.settingsPath, JSON.stringify(this.settings, null, 2));
        } catch (error) {
            console.error('Error saving settings:', error);
        }
    }

    public getSettings(): Settings {
        return { ...this.settings };
    }

    public updateSettings(newSettings: Partial<Settings>): void {
        this.settings = {
            ...this.settings,
            ...newSettings
        };
        this.saveSettings();
    }

    public updateFeeSettings(feeSettings: Partial<Settings['fees']>): void {
        this.settings.fees = {
            ...this.settings.fees,
            ...feeSettings
        };
        this.saveSettings();
    }

    public updateConnectionSettings(connectionSettings: Partial<Settings['connection']>): void {
        this.settings.connection = {
            ...this.settings.connection,
            ...connectionSettings
        };
        this.saveSettings();
    }

    public updateNotificationSettings(notificationSettings: Partial<Settings['notifications']>): void {
        this.settings.notifications = {
            ...this.settings.notifications,
            ...notificationSettings
        };
        this.saveSettings();
    }
}