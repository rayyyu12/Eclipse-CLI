"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.spinner = exports.rl = void 0;
exports.promptWithValidation = promptWithValidation;
exports.displayError = displayError;
exports.displaySuccess = displaySuccess;
exports.displayInfo = displayInfo;
exports.displayWarning = displayWarning;
exports.startSpinner = startSpinner;
exports.stopSpinner = stopSpinner;
exports.updateSpinner = updateSpinner;
//formatting.ts
const chalk_1 = __importDefault(require("chalk"));
const readline_1 = require("readline");
const ora_1 = __importDefault(require("ora"));
const config_1 = require("../config");
// Custom smoother arc spinner
const SMOOTH_SPINNER = {
    interval: 40, // Fast interval for smooth animation
    frames: [
        "◜", "◜", "◜",
        "◠", "◠", "◠",
        "◝", "◝", "◝",
        "◞", "◞", "◞",
        "◡", "◡", "◡",
        "◟", "◟", "◟"
    ] // Tripled frames for smoother transitions
};
function getSpinnerColor(hex) {
    return 'magenta';
}
const SPINNER_CONFIG = {
    color: getSpinnerColor(config_1.COLORS.PRIMARY)
};
exports.rl = (0, readline_1.createInterface)({
    input: process.stdin,
    output: process.stdout
});
exports.spinner = (0, ora_1.default)({
    color: SPINNER_CONFIG.color,
    spinner: SMOOTH_SPINNER
});
async function promptWithValidation(question, validator, errorMessage) {
    while (true) {
        const answer = await new Promise(resolve => {
            exports.rl.question(chalk_1.default.hex(config_1.COLORS.PRIMARY)(question), resolve);
        });
        if (validator(answer)) {
            return answer;
        }
        console.log(chalk_1.default.hex(config_1.COLORS.ERROR)(errorMessage));
    }
}
function displayError(message, error) {
    exports.spinner.fail(chalk_1.default.hex(config_1.COLORS.ERROR)(message));
    if (error) {
        console.error(chalk_1.default.hex(config_1.COLORS.ERROR)("Error details:"), error instanceof Error ? error.message : 'Unknown error');
    }
}
function displaySuccess(message, details) {
    exports.spinner.succeed(chalk_1.default.hex(config_1.COLORS.SUCCESS)(message));
    if (details) {
        console.log(chalk_1.default.hex(config_1.COLORS.SUCCESS)(details));
    }
}
function displayInfo(message) {
    exports.spinner.info(chalk_1.default.hex(config_1.COLORS.PRIMARY)(message));
}
function displayWarning(message) {
    exports.spinner.warn(chalk_1.default.hex(config_1.COLORS.PRIMARY)(message));
}
function startSpinner(message) {
    exports.spinner.start(chalk_1.default.hex(config_1.COLORS.PRIMARY)(message));
}
function stopSpinner() {
    exports.spinner.stop();
}
function updateSpinner(message) {
    exports.spinner.text = chalk_1.default.hex(config_1.COLORS.PRIMARY)(message);
}
