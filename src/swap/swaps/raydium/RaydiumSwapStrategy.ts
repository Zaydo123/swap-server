import {
    Connection,
    PublicKey,
    TransactionInstruction,
    AddressLookupTableAccount,
    VersionedTransaction,
    SystemProgram,
    LAMPORTS_PER_SOL // Added for fee calculation
} from '@solana/web3.js';
import {
    LiquidityPoolKeys, 
    LiquidityStateV4, 
    Percent,
    Token,
    TokenAmount,
    TxVersion,
    ApiV3PoolInfoStandardItem, 
    Raydium,
    parseBigNumberish // Util for amounts
} from '@raydium-io/raydium-sdk-v2'; 
import BN from 'bn.js';
import Decimal from 'decimal.js';
import { NATIVE_MINT, getAssociatedTokenAddress, createCloseAccountInstruction } from '@solana/spl-token'; // For SOL handling
import { TransactionProps, GenerateInstructionsResult, SwapStrategyDependencies, ISwapStrategy } from '../base/ISwapStrategy';
import { FEE_RECIPIENT } from '../../constants';
import { prepareTokenAccounts } from '../../../utils/tokenAccounts';
import { calculateSendyFee, makeSendyFeeInstruction } from '../../../utils/feeUtils';
import { addWsolUnwrapInstructionIfNeeded } from '../../../utils/tokenAccounts';

export class RaydiumSwapStrategy implements ISwapStrategy {

    async canHandle(
        transactionDetails: TransactionProps,
        dependencies: SwapStrategyDependencies
    ): Promise<boolean> {
        const mintAddress = transactionDetails.params.inputMint;
        console.log("Checking RaydiumStrategy eligibility for:", mintAddress);

        // Check for Pump.fun tokens first
        if (mintAddress.toLowerCase().includes('pump')) {
            console.log(`RaydiumStrategy: Detected pump token ${mintAddress}, checking details...`);
            try {
                const dataURL = `https://frontend-api-v3.pump.fun/coins/${mintAddress}`;
                const response = await fetch(dataURL);
                if (!response.ok) {
                    console.warn(`RaydiumStrategy: Failed to fetch pump.fun data for ${mintAddress} (${response.status}). Rejecting.`);
                    return false; // Cannot verify, reject
                }
                const data = await response.json();

                // Condition: Can handle if it HAS a raydium_pool AND was created BEFORE the cutoff timestamp
                const hasRaydiumPool = !!data.raydium_pool;
                const createdTimestamp = data.created_timestamp;
                const isBeforeCutoff = createdTimestamp && createdTimestamp < 1742234121000;

                if (hasRaydiumPool && isBeforeCutoff) {
                    console.log(`RaydiumStrategy: Pump token ${mintAddress} has Raydium pool (${data.raydium_pool}) and created before cutoff (${new Date(createdTimestamp).toISOString()}). CAN handle.`);
                    return true; // Old, migrated pump token with a Raydium pool
                } else {
                    console.log(`RaydiumStrategy: Pump token ${mintAddress} does not meet Raydium criteria (hasRaydiumPool: ${hasRaydiumPool}, isBeforeCutoff: ${isBeforeCutoff}). Rejecting.`);
                    return false; // Newer pump token or one without Raydium pool
                }
            } catch (error) {
                console.error(`RaydiumStrategy: Error checking pump.fun details for ${mintAddress}:`, error);
                return false; // Error during check, reject
            }
        }

        // Check for Moonshot tokens
        if (mintAddress.toLowerCase().includes('moon')) {
            console.log(`RaydiumStrategy: Detected moon token ${mintAddress}, checking migration...`);
            try {
                const response = await fetch(`https://api.moonshot.cc/token/v1/solana/${mintAddress}`);
                 if (!response.ok) {
                    console.warn(`RaydiumStrategy: Failed to fetch moonshot data for ${mintAddress} (${response.status}). Rejecting.`);
                    return false; // Cannot verify, reject
                }
                const data = await response.json();
                const isMigrated = data?.moonshot?.progress === 100;

                if (isMigrated) {
                    console.log(`RaydiumStrategy: Moon token ${mintAddress} is fully migrated. CAN handle.`);
                    return true; // Raydium handles fully migrated Moonshot tokens
                } else {
                    console.log(`RaydiumStrategy: Moon token ${mintAddress} is not fully migrated (progress: ${data?.moonshot?.progress}%). Rejecting.`);
                    return false; // MoonshotSwapStrategy handles non-migrated tokens
                }
            } catch (error) {
                console.error(`RaydiumStrategy: Error checking moonshot details for ${mintAddress}:`, error);
                return false; // Error during check, reject
            }
        }

        // Final check: Verify if the token exists on standard Raydium pools
        console.log(`RaydiumStrategy: Performing final check for ${mintAddress} on standard Raydium pools...`);
        try {
            // Initialize Raydium SDK instance for the check
            const raydium = await Raydium.load({ 
                connection: dependencies.connection, 
                cluster: 'mainnet', 
                disableFeatureCheck: true, // Can be true for read-only checks
                // No owner needed for public pool fetching
            });

            // Fetch pool info using the SDK
            const poolInfo = await raydium.api.fetchPoolByMints({ 
                mint1: NATIVE_MINT.toString(), 
                mint2: mintAddress 
            });

            // Check if pool data was found
            if (poolInfo && poolInfo.data && poolInfo.data.length > 0) {
                 console.log(`RaydiumStrategy: Standard Raydium pool found for ${mintAddress}. CAN handle.`);
                 return true;
            } else {
                console.log(`RaydiumStrategy: No standard Raydium pool found for ${mintAddress} via SDK. Rejecting.`);
                return false;
            }
        } catch (error) {
             console.error(`RaydiumStrategy: Error during final Raydium pool check for ${mintAddress}:`, error);
             return false; // Error during check, reject
        }
    }

    async generateSwapInstructions(
        transactionDetails: TransactionProps,
        dependencies: SwapStrategyDependencies
    ): Promise<GenerateInstructionsResult> {
        const { inputMint, outputMint, amount, slippageBps, userWalletAddress } = transactionDetails.params;
        const { connection } = dependencies;
        const userPublicKey = new PublicKey(userWalletAddress!);

        if (!inputMint || !outputMint || !amount || !slippageBps) {
            return { success: false, error: 'Missing required swap parameters.' };
        }

        try {
            // 1. Find Pool ID (sort mints for canonical order)
            const mintA = inputMint < outputMint ? inputMint : outputMint;
            const mintB = inputMint < outputMint ? outputMint : inputMint;
            const poolIdString = await this.getPoolAddressForTokens(connection, mintA, mintB);

            if (!poolIdString) {
                return { success: false, error: 'Could not find Raydium pool for the given pair.' };
            }
            const poolId = poolIdString;
            console.log(`Found Raydium pool: ${poolId}`);

            // 2. Load Raydium SDK instance
            const raydium = await Raydium.load({ 
                connection, 
                cluster: 'mainnet',
                disableFeatureCheck: true, 
                disableLoadToken: true 
            });

            // 3. Fetch pool info (SDK returns { poolInfo, poolKeys, poolRpcData })
            const { poolInfo, poolKeys, poolRpcData } = await raydium.liquidity.getPoolInfoFromRpc({ poolId });
            const [baseReserve, quoteReserve, status] = [poolRpcData.baseReserve, poolRpcData.quoteReserve, poolRpcData.status.toNumber()];

            // 4. Validate input mint
            if (poolInfo.mintA.address !== inputMint && poolInfo.mintB.address !== inputMint)
                return { success: false, error: 'Input mint does not match pool.' };

            // 5. Determine mintIn/mintOut
            const baseIn = inputMint === poolInfo.mintA.address;
            const [mintIn, mintOut] = baseIn ? [poolInfo.mintA, poolInfo.mintB] : [poolInfo.mintB, poolInfo.mintA];

            // 6. Compute output amount using SDK
            const out = raydium.liquidity.computeAmountOut({
                poolInfo: {
                    ...poolInfo,
                    baseReserve,
                    quoteReserve,
                    status,
                    version: 4,
                },
                amountIn: new BN(amount),
                mintIn: mintIn.address,
                mintOut: mintOut.address,
                slippage: slippageBps / 10000, // Convert BPS to decimal (e.g., 50 -> 0.005)
            });

            // 7. Prepare token accounts (ATAs)
            let ataInstructions: TransactionInstruction[] = [];
            await prepareTokenAccounts({
                connection,
                userPublicKey,
                mints: [new PublicKey(inputMint), new PublicKey(outputMint)],
                instructions: ataInstructions
            });

            // 8. Build swap instructions using SDK
            const swapResult = await raydium.liquidity.swap({
                poolInfo,
                poolKeys,
                amountIn: new BN(amount),
                amountOut: out.minAmountOut,
                fixedSide: 'in',
                inputMint: mintIn.address,
            });
            // Extract instructions from the transaction builder (if present)
            let swapInstructions: TransactionInstruction[] = [];
            let cleanupInstructions: TransactionInstruction[] = [];
            if ('innerTransactions' in swapResult && Array.isArray(swapResult.innerTransactions)) {
                // Use all instructions from all inner transactions
                swapInstructions = swapResult.innerTransactions.flatMap(
                    (tx: any) => (tx.instructions as TransactionInstruction[]) || []
                );
                cleanupInstructions = swapResult.innerTransactions.flatMap(
                    (tx: any) => (tx.cleanupInstructions as TransactionInstruction[]) || []
                );
            } else if ('instructions' in swapResult) {
                swapInstructions = swapResult.instructions as TransactionInstruction[];
            }

            // 8.5. Add WSOL unwrap instruction if needed (shared utility)
            await addWsolUnwrapInstructionIfNeeded({
                outputMint,
                userPublicKey,
                instructions: cleanupInstructions
            });

            // 9. Fee Instruction
            let feeInstruction: TransactionInstruction | undefined = undefined;
            const feeBps = 5;
            const sendyFeeLamports = Number(calculateSendyFee({ amountLamports: BigInt(amount), feeBps }));
            if (sendyFeeLamports > 0) {
                feeInstruction = makeSendyFeeInstruction({
                    from: userPublicKey,
                    to: FEE_RECIPIENT,
                    lamports: sendyFeeLamports,
                });
            }

            // 10. Concatenate all instructions in correct order
            const allInstructions: TransactionInstruction[] = [
                ...(feeInstruction ? [feeInstruction] : []),
                ...ataInstructions,
                ...swapInstructions,
                ...(cleanupInstructions || []),
            ];

            return {
                success: true,
                instructions: allInstructions,
                addressLookupTables: [],
                poolAddress: new PublicKey(poolId),
                sendyFeeLamports,
            };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    }

    private async getPoolAddressForTokens(connection: Connection, mintA: string, mintB: string): Promise<string | null> {
        try {
            const raydium = await Raydium.load({ 
                connection, 
                cluster: 'mainnet',
                disableFeatureCheck: true, 
                disableLoadToken: true 
            });
            // Use the SDK's pool search method if available, else fallback to fetchPoolByMints
            const result = await raydium.api.fetchPoolByMints({ mint1: mintA, mint2: mintB });
            const poolObj = (result && typeof result === 'object') ? Object.values(result)[0] as any : null;
            if (poolObj && poolObj.id) {
                return poolObj.id;
            }
            return null;
        } catch (error) {
            console.error("Error finding Raydium pool address:", error);
            return null;
        }
    }
}