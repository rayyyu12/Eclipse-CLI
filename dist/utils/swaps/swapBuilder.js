"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.transactionBuffer = exports.computeBudgetIx = exports.createWSOLAccountInstruction = void 0;
exports.buildSwapInstruction = buildSwapInstruction;
//swapBuilder.ts
const web3_js_1 = require("@solana/web3.js");
const spl_token_1 = require("@solana/spl-token");
const web3_js_2 = require("@solana/web3.js");
// Pre-computed instructions
const WSOL_MINT = new web3_js_1.PublicKey("So11111111111111111111111111111111111111112");
const createWSOLAccountInstruction = (wallet, wsolAccount) => web3_js_1.SystemProgram.createAccount({
    fromPubkey: wallet,
    newAccountPubkey: wsolAccount,
    lamports: web3_js_1.LAMPORTS_PER_SOL,
    space: spl_token_1.AccountLayout.span,
    programId: spl_token_1.TOKEN_PROGRAM_ID
});
exports.createWSOLAccountInstruction = createWSOLAccountInstruction;
const computeBudgetIx = web3_js_2.ComputeBudgetProgram.setComputeUnitLimit({
    units: 1400000
});
exports.computeBudgetIx = computeBudgetIx;
// Pre-allocated buffer
const BUFFER_SIZE = 1024;
const transactionBuffer = Buffer.alloc(BUFFER_SIZE);
exports.transactionBuffer = transactionBuffer;
async function buildSwapInstruction(wallet, userSourceTokenAccount, userDestinationTokenAccount, pool, amountIn, minAmountOut, silent = false) {
    try {
        // Raydium V4 program ID
        const RAYDIUM_V4_PROGRAM_ID = new web3_js_1.PublicKey("675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8");
        // Set up the instruction data for SwapBaseIn
        const data = Buffer.from([
            9, // SwapBaseIn instruction discriminator
            ...amountIn.toArray("le", 8),
            ...minAmountOut.toArray("le", 8)
        ]);
        return new web3_js_1.TransactionInstruction({
            programId: RAYDIUM_V4_PROGRAM_ID,
            keys: [
                { pubkey: spl_token_1.TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
                { pubkey: pool.ammId, isSigner: false, isWritable: true },
                { pubkey: pool.ammAuthority, isSigner: false, isWritable: false },
                { pubkey: pool.ammOpenOrders, isSigner: false, isWritable: true },
                { pubkey: pool.ammTargetOrders, isSigner: false, isWritable: true },
                { pubkey: pool.poolCoinTokenAccount, isSigner: false, isWritable: true },
                { pubkey: pool.poolPcTokenAccount, isSigner: false, isWritable: true },
                { pubkey: pool.serumProgramId, isSigner: false, isWritable: false },
                { pubkey: pool.serumMarket, isSigner: false, isWritable: true },
                { pubkey: pool.serumBids, isSigner: false, isWritable: true },
                { pubkey: pool.serumAsks, isSigner: false, isWritable: true },
                { pubkey: pool.serumEventQueue, isSigner: false, isWritable: true },
                { pubkey: pool.serumCoinVaultAccount, isSigner: false, isWritable: true },
                { pubkey: pool.serumPcVaultAccount, isSigner: false, isWritable: true },
                { pubkey: pool.serumVaultSigner, isSigner: false, isWritable: false },
                { pubkey: userSourceTokenAccount, isSigner: false, isWritable: true },
                { pubkey: userDestinationTokenAccount, isSigner: false, isWritable: true },
                { pubkey: wallet, isSigner: true, isWritable: false }
            ],
            data
        });
    }
    catch (error) {
        if (!silent) {
            console.error('Error building swap instruction:', error);
        }
        throw error;
    }
}
