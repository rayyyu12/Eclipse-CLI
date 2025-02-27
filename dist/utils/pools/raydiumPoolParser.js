"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parsePoolInfo = parsePoolInfo;
//raydiumPoolParser.ts
const web3_js_1 = require("@solana/web3.js");
const raydium_sdk_1 = require("@raydium-io/raydium-sdk");
const serum_1 = require("@project-serum/serum");
const OPENBOOK_PROGRAM_ID = new web3_js_1.PublicKey("srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX");
const RAYDIUM_PROGRAM_ID = new web3_js_1.PublicKey("675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8");
async function parsePoolInfo(connection, poolAddress) {
    const accountInfo = await connection.getAccountInfo(poolAddress);
    if (!accountInfo) {
        throw new Error(`Pool account ${poolAddress.toBase58()} not found`);
    }
    const poolData = raydium_sdk_1.LIQUIDITY_STATE_LAYOUT_V4.decode(accountInfo.data);
    // Load OpenBook market
    const market = await serum_1.Market.load(connection, poolData.marketId, {}, OPENBOOK_PROGRAM_ID);
    // Get AMM authority PDA
    const [ammAuthority] = await web3_js_1.PublicKey.findProgramAddress([Buffer.from("amm authority")], RAYDIUM_PROGRAM_ID);
    // Get vault signer PDA
    const vaultSigner = await web3_js_1.PublicKey.createProgramAddress([
        market.address.toBuffer(),
        market.decoded.vaultSignerNonce.toArrayLike(Buffer, 'le', 8)
    ], OPENBOOK_PROGRAM_ID);
    return {
        id: `${poolData.baseMint.toBase58()}/${poolData.quoteMint.toBase58()}`,
        ammId: poolAddress,
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
