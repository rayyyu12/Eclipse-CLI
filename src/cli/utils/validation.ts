// src/cli/utils/validation.ts
import { PublicKey } from "@solana/web3.js";
import { CONFIG } from '../config';

export function validateSolAmount(amount: string): boolean {
    const num = parseFloat(amount);
    return !isNaN(num) && num > CONFIG.MIN_SOL_AMOUNT && num < CONFIG.MAX_SOL_AMOUNT;
}

export function validatePublicKey(address: string): boolean {
    try {
        new PublicKey(address);
        return true;
    } catch {
        return false;
    }
}

export function validatePercentage(value: string): boolean {
    const num = parseFloat(value);
    return !isNaN(num) && num > 0 && num <= 100;
}