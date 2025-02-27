"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.discoverPool = discoverPool;
exports.findAllPools = findAllPools;
//poolDiscovery.ts
const web3_js_1 = require("@solana/web3.js");
const raydium_sdk_1 = require("@raydium-io/raydium-sdk");
const serum_1 = require("@project-serum/serum");
const raydiumPoolParser_1 = require("./raydiumPoolParser");
const RAYDIUM_PROGRAM_ID = new web3_js_1.PublicKey("675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8");
const OPENBOOK_PROGRAM_ID = new web3_js_1.PublicKey("srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX");
async function getPoolAccounts(connection, marketId, poolAddress) {
    try {
        const market = await serum_1.Market.load(connection, marketId, { commitment: 'confirmed' }, OPENBOOK_PROGRAM_ID);
        const [ammAuthority] = await web3_js_1.PublicKey.findProgramAddress([Buffer.from("amm authority")], RAYDIUM_PROGRAM_ID);
        const vaultSigner = await web3_js_1.PublicKey.createProgramAddress([
            marketId.toBuffer(),
            market.decoded.vaultSignerNonce.toArrayLike(Buffer, 'le', 8)
        ], OPENBOOK_PROGRAM_ID);
        return {
            market,
            ammAuthority,
            vaultSigner
        };
    }
    catch (error) {
        throw new Error(`Failed to get pool accounts: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
}
async function findPoolByMints(connection, baseMint, quoteMint) {
    let foundPoolAccounts = await connection.getProgramAccounts(RAYDIUM_PROGRAM_ID, {
        commitment: 'confirmed',
        filters: [
            { dataSize: raydium_sdk_1.LIQUIDITY_STATE_LAYOUT_V4.span },
            {
                memcmp: {
                    offset: raydium_sdk_1.LIQUIDITY_STATE_LAYOUT_V4.offsetOf("baseMint"),
                    bytes: baseMint.toBase58(),
                },
            },
            {
                memcmp: {
                    offset: raydium_sdk_1.LIQUIDITY_STATE_LAYOUT_V4.offsetOf("quoteMint"),
                    bytes: quoteMint.toBase58(),
                },
            },
        ],
    });
    if (!foundPoolAccounts || foundPoolAccounts.length === 0) {
        foundPoolAccounts = await connection.getProgramAccounts(RAYDIUM_PROGRAM_ID, {
            commitment: 'confirmed',
            filters: [
                { dataSize: raydium_sdk_1.LIQUIDITY_STATE_LAYOUT_V4.span },
                {
                    memcmp: {
                        offset: raydium_sdk_1.LIQUIDITY_STATE_LAYOUT_V4.offsetOf("baseMint"),
                        bytes: quoteMint.toBase58(),
                    },
                },
                {
                    memcmp: {
                        offset: raydium_sdk_1.LIQUIDITY_STATE_LAYOUT_V4.offsetOf("quoteMint"),
                        bytes: baseMint.toBase58(),
                    },
                },
            ],
        });
        if (!foundPoolAccounts || foundPoolAccounts.length === 0) {
            throw new Error(`No liquidity pool found for ${baseMint.toBase58()} and ${quoteMint.toBase58()}`);
        }
    }
    const poolAccount = foundPoolAccounts[0];
    const poolData = raydium_sdk_1.LIQUIDITY_STATE_LAYOUT_V4.decode(poolAccount.account.data);
    const { market, ammAuthority, vaultSigner } = await getPoolAccounts(connection, poolData.marketId, poolAccount.pubkey);
    return {
        id: `${baseMint.toBase58()}/${quoteMint.toBase58()}`,
        ammId: poolAccount.pubkey,
        ammAuthority,
        ammOpenOrders: poolData.openOrders,
        ammTargetOrders: poolData.targetOrders,
        poolCoinTokenAccount: poolData.baseVault,
        poolPcTokenAccount: poolData.quoteVault,
        serumProgramId: OPENBOOK_PROGRAM_ID,
        serumMarket: poolData.marketId,
        serumBids: market.bidsAddress,
        serumAsks: market.asksAddress,
        serumEventQueue: market.decoded.eventQueue,
        serumCoinVaultAccount: market.decoded.baseVault,
        serumPcVaultAccount: market.decoded.quoteVault,
        serumVaultSigner: vaultSigner
    };
}
async function discoverPool(connection, inputMint, outputMint, silent = false) {
    return await findPoolByMints(connection, inputMint, outputMint);
}
async function findAllPools(connection, tokenMint) {
    const poolAccounts = await connection.getProgramAccounts(RAYDIUM_PROGRAM_ID, {
        commitment: 'confirmed',
        filters: [
            { dataSize: raydium_sdk_1.LIQUIDITY_STATE_LAYOUT_V4.span },
            {
                memcmp: {
                    offset: raydium_sdk_1.LIQUIDITY_STATE_LAYOUT_V4.offsetOf("baseMint"),
                    bytes: tokenMint.toBase58(),
                },
            },
        ],
    });
    const pools = await Promise.all(poolAccounts.map(async (account) => {
        try {
            return await (0, raydiumPoolParser_1.parsePoolInfo)(connection, account.pubkey);
        }
        catch {
            return null;
        }
    }));
    return pools.filter((pool) => pool !== null);
}
