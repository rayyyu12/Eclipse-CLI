//formatting.ts
import chalk from 'chalk';
import { createInterface } from 'readline';
import ora from 'ora';
import { COLORS } from '../config';

// Create a local config object if you don't want to import from config.ts
const SPINNER_CONFIG = {
    color: 'cyan' as const  // Type assertion to prevent type errors
};

export const rl = createInterface({
    input: process.stdin,
    output: process.stdout
});

export const spinner = ora({ color: SPINNER_CONFIG.color });

export async function promptWithValidation(
    question: string,
    validator: (input: string) => boolean,
    errorMessage: string
): Promise<string> {
    while (true) {
        const answer = await new Promise<string>(resolve => {
            rl.question(chalk.hex(COLORS.ACCENT)(question), resolve);
        });
        
        if (validator(answer)) {
            return answer;
        }
        console.log(chalk.hex(COLORS.ERROR)(errorMessage));
    }
}

export function displayError(message: string, error?: unknown): void {
    spinner.fail(message);
    if (error) {
        console.error(chalk.hex(COLORS.ERROR)("Error details:"), 
            error instanceof Error ? error.message : 'Unknown error');
    }
}

export function displaySuccess(message: string, details?: string): void {
    spinner.succeed(message);
    if (details) {
        console.log(chalk.hex(COLORS.SUCCESS)(details));
    }
}