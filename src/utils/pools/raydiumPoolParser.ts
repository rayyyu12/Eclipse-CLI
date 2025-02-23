import { Connection, PublicKey } from "@solana/web3.js";
import { LIQUIDITY_STATE_LAYOUT_V4 } from "@raydium-io/raydium-sdk";
import { Market } from "@project-serum/serum";
import { PoolAccounts } from "../../types";

const OPENBOOK_PROGRAM_ID = new PublicKey("srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX");
const RAYDIUM_PROGRAM_ID = new PublicKey("675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8");

export async function parsePoolInfo(
    connection: Connection,
    poolAddress: PublicKey
): Promise<PoolAccounts> {
    const accountInfo = await connection.getAccountInfo(poolAddress);
    if (!accountInfo) {
        throw new Error(`Pool account ${poolAddress.toBase58()} not found`);
    }

    const poolData = LIQUIDITY_STATE_LAYOUT_V4.decode(accountInfo.data);
    
    // Load OpenBook market
    const market = await Market.load(
        connection,
        poolData.marketId,
        {},
        OPENBOOK_PROGRAM_ID
    );

    // Get AMM authority PDA
    const [ammAuthority] = await PublicKey.findProgramAddress(
        [Buffer.from("amm authority")],
        RAYDIUM_PROGRAM_ID
    );

    // Get vault signer PDA
    const vaultSigner = await PublicKey.createProgramAddress(
        [
            market.address.toBuffer(),
            market.decoded.vaultSignerNonce.toArrayLike(Buffer, 'le', 8)
        ],
        OPENBOOK_PROGRAM_ID
    );

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