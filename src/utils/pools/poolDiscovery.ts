//poolDiscovery.ts
import { Connection, PublicKey } from "@solana/web3.js";
import { LIQUIDITY_STATE_LAYOUT_V4 } from "@raydium-io/raydium-sdk";
import { Market } from "@project-serum/serum";
import { PoolAccounts } from "../../types";
import { parsePoolInfo } from './raydiumPoolParser';

const RAYDIUM_PROGRAM_ID = new PublicKey("675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8");
const OPENBOOK_PROGRAM_ID = new PublicKey("srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX");

async function getPoolAccounts(
    connection: Connection,
    marketId: PublicKey,
    poolAddress: PublicKey
) {
    try {
        const market = await Market.load(
            connection,
            marketId,
            { commitment: 'confirmed' },
            OPENBOOK_PROGRAM_ID
        );

        const [ammAuthority] = await PublicKey.findProgramAddress(
            [Buffer.from("amm authority")],
            RAYDIUM_PROGRAM_ID
        );

        const vaultSigner = await PublicKey.createProgramAddress(
            [
                marketId.toBuffer(),
                market.decoded.vaultSignerNonce.toArrayLike(Buffer, 'le', 8)
            ],
            OPENBOOK_PROGRAM_ID
        );

        return {
            market,
            ammAuthority,
            vaultSigner
        };
    } catch (error) {
        throw new Error(`Failed to get pool accounts: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
}

async function findPoolByMints(
    connection: Connection,
    baseMint: PublicKey,
    quoteMint: PublicKey
): Promise<PoolAccounts> {
    let foundPoolAccounts = await connection.getProgramAccounts(RAYDIUM_PROGRAM_ID, {
        commitment: 'confirmed',
        filters: [
            { dataSize: LIQUIDITY_STATE_LAYOUT_V4.span },
            {
                memcmp: {
                    offset: LIQUIDITY_STATE_LAYOUT_V4.offsetOf("baseMint"),
                    bytes: baseMint.toBase58(),
                },
            },
            {
                memcmp: {
                    offset: LIQUIDITY_STATE_LAYOUT_V4.offsetOf("quoteMint"),
                    bytes: quoteMint.toBase58(),
                },
            },
        ],
    });

    if (!foundPoolAccounts || foundPoolAccounts.length === 0) {
        foundPoolAccounts = await connection.getProgramAccounts(RAYDIUM_PROGRAM_ID, {
            commitment: 'confirmed',
            filters: [
                { dataSize: LIQUIDITY_STATE_LAYOUT_V4.span },
                {
                    memcmp: {
                        offset: LIQUIDITY_STATE_LAYOUT_V4.offsetOf("baseMint"),
                        bytes: quoteMint.toBase58(),
                    },
                },
                {
                    memcmp: {
                        offset: LIQUIDITY_STATE_LAYOUT_V4.offsetOf("quoteMint"),
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
    const poolData = LIQUIDITY_STATE_LAYOUT_V4.decode(poolAccount.account.data);
    
    const { market, ammAuthority, vaultSigner } = await getPoolAccounts(
        connection,
        poolData.marketId,
        poolAccount.pubkey
    );

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

export async function discoverPool(
    connection: Connection,
    inputMint: PublicKey,
    outputMint: PublicKey,
    silent: boolean = false
): Promise<PoolAccounts> {
    return await findPoolByMints(connection, inputMint, outputMint);
}

export async function findAllPools(
    connection: Connection,
    tokenMint: PublicKey
): Promise<PoolAccounts[]> {
    const poolAccounts = await connection.getProgramAccounts(RAYDIUM_PROGRAM_ID, {
        commitment: 'confirmed',
        filters: [
            { dataSize: LIQUIDITY_STATE_LAYOUT_V4.span },
            {
                memcmp: {
                    offset: LIQUIDITY_STATE_LAYOUT_V4.offsetOf("baseMint"),
                    bytes: tokenMint.toBase58(),
                },
            },
        ],
    });

    const pools = await Promise.all(
        poolAccounts.map(async account => {
            try {
                return await parsePoolInfo(connection, account.pubkey);
            } catch {
                return null;
            }
        })
    );
    
    return pools.filter((pool): pool is PoolAccounts => pool !== null);
}
