// src/cli/handlers/positionsHandler.ts
import { PortfolioTracker } from '../../utils/positions/portfolioTracker';
import { setupConnection } from '../../index';
import { spinner, displayError } from '../utils/formatting';

export async function handlePositions(): Promise<void> {
    try {
        spinner.start('Fetching positions...');
        const { connection, wallet } = await setupConnection();  // Get both connection and wallet
        const tracker = PortfolioTracker.getInstance();
        await tracker.displayPortfolio(connection, wallet.publicKey);  // Use tracker, not portfolioTracker
        spinner.stop();
    } catch (error) {
        displayError('Error displaying positions:', error);
    }
}