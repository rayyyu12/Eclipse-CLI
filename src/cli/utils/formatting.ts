import chalk from 'chalk';
import { createInterface } from 'readline';
import ora, { Color } from 'ora';
import { COLORS } from '../config';

// Custom smoother arc spinner
const SMOOTH_SPINNER = {
    interval: 40,  // Fast interval for smooth animation
    frames: [
        "◜", "◜", "◜",
        "◠", "◠", "◠",
        "◝", "◝", "◝",
        "◞", "◞", "◞",
        "◡", "◡", "◡",
        "◟", "◟", "◟"
    ]  // Tripled frames for smoother transitions
};

function getSpinnerColor(hex: string): Color {
    return 'magenta' as Color;
}

const SPINNER_CONFIG = {
    color: getSpinnerColor(COLORS.PRIMARY)
};

export const rl = createInterface({
    input: process.stdin,
    output: process.stdout
});

export const spinner = ora({ 
    color: SPINNER_CONFIG.color,
    spinner: SMOOTH_SPINNER
});

export async function promptWithValidation(
    question: string,
    validator: (input: string) => boolean,
    errorMessage: string
): Promise<string> {
    while (true) {
        const answer = await new Promise<string>(resolve => {
            rl.question(chalk.hex(COLORS.PRIMARY)(question), resolve);
        });
        
        if (validator(answer)) {
            return answer;
        }
        console.log(chalk.hex(COLORS.ERROR)(errorMessage));
    }
}

export function displayError(message: string, error?: unknown): void {
    spinner.fail(chalk.hex(COLORS.ERROR)(message));
    if (error) {
        console.error(
            chalk.hex(COLORS.ERROR)("Error details:"), 
            error instanceof Error ? error.message : 'Unknown error'
        );
    }
}

export function displaySuccess(message: string, details?: string): void {
    spinner.succeed(chalk.hex(COLORS.SUCCESS)(message));
    if (details) {
        console.log(chalk.hex(COLORS.SUCCESS)(details));
    }
}

export function displayInfo(message: string): void {
    spinner.info(chalk.hex(COLORS.PRIMARY)(message));
}

export function displayWarning(message: string): void {
    spinner.warn(chalk.hex(COLORS.PRIMARY)(message));
}

export function startSpinner(message: string): void {
    spinner.start(chalk.hex(COLORS.PRIMARY)(message));
}

export function stopSpinner(): void {
    spinner.stop();
}

export function updateSpinner(message: string): void {
    spinner.text = chalk.hex(COLORS.PRIMARY)(message);
}