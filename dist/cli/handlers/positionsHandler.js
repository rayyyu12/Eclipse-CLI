"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handlePositions = handlePositions;
// src/cli/handlers/positionsHandler.ts
const portfolioTracker_1 = require("../../utils/positions/portfolioTracker");
const index_1 = require("../../index");
const formatting_1 = require("../utils/formatting");
async function handlePositions() {
    try {
        formatting_1.spinner.start('Fetching positions...');
        const { connection, wallet } = await (0, index_1.setupConnection)(); // Get both connection and wallet
        const tracker = portfolioTracker_1.PortfolioTracker.getInstance();
        await tracker.displayPortfolio(connection, wallet.publicKey); // Use tracker, not portfolioTracker
        formatting_1.spinner.stop();
    }
    catch (error) {
        (0, formatting_1.displayError)('Error displaying positions:', error);
    }
}
