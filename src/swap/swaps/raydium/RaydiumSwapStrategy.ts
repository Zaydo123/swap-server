import { TransactionProps } from '../../swap'; // Adjust path
import { ISwapStrategy, GenerateInstructionsResult, SwapStrategyDependencies } from '../base/ISwapStrategy';
import { RaydiumSwap } from '../../../raydium-generator'; // Corrected path
import { VersionedTransaction } from '@solana/web3.js';
import { Raydium } from '@raydium-io/raydium-sdk-v2';
import { NATIVE_MINT } from '@solana/spl-token';
import { PublicKey } from '@solana/web3.js';
import { ensureUserTokenAccounts } from '../utils/ensureTokenAccounts';

// Define the cutoff timestamp for using Raydium for older Pump tokens
const PUMP_FUN_RAYDIUM_CUTOFF_TIMESTAMP = 1742234121000;


export class RaydiumSwapStrategy implements ISwapStrategy {

    async canHandle(
        transactionDetails: TransactionProps,
        dependencies: SwapStrategyDependencies
    ): Promise<boolean> {
        const mintAddress = transactionDetails.params.mintAddress;
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
                const isBeforeCutoff = createdTimestamp && createdTimestamp < PUMP_FUN_RAYDIUM_CUTOFF_TIMESTAMP;

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
    ): Promise<GenerateInstructionsResult & { _raydiumVersionedTx?: VersionedTransaction }> {
        console.log('--- Generating Raydium Swap Instructions (via getSwapTransaction) ---');
        const { heliusRpcUrl } = dependencies;
        const { mintAddress, amount, slippage, computeUnitPrice, type } = transactionDetails.params;

        const raydiumSwap = new RaydiumSwap(
            heliusRpcUrl,
            transactionDetails.secret || ''
        );

        console.log('Calling RaydiumSwap.getSwapTransaction with:', {
            tokenAddress: mintAddress,
            amount, // Amount in display units
            slippage: slippage, // Slippage as percentage (e.g., 0.5)
            computeUnitPrice, // Pass CU price for Raydium API
            isSell: type === 'sell',
        });

        try {
            // Ensure user token accounts exist for both base and quote mints (middleware)
            // You may need to determine the correct base/quote mints from the pool or params
            // For Raydium, mintAddress is usually the token, and NATIVE_MINT is the quote for SOL pairs
            const userPublicKey = new PublicKey(transactionDetails.params.userWalletAddress);
            const baseMint = new PublicKey(mintAddress);
            const quoteMint = NATIVE_MINT;
            await ensureUserTokenAccounts({
                connection: dependencies.connection,
                userPublicKey,
                mints: [baseMint, quoteMint],
                preparatoryInstructions: [] // If you have a preparatoryInstructions array, use it; otherwise, pass an empty array
            });

            // Call the original method that returns a VersionedTransaction and the fee
            const { tx: raydiumTransaction, sendyFeeLamports } = await raydiumSwap.getSwapTransaction(
                 mintAddress,
                 amount,
                 slippage,
                 computeUnitPrice,
                 type === 'sell'
             );

            console.log("RaydiumSwap.getSwapTransaction successful.");
            
            // We've found that trying to decompile the versioned transaction into separate
            // instructions causes issues with account indices and duplicate instructions.
            // Instead, we'll return an empty instructions array and rely on the caller
            // to use the raydiumTransaction property directly.
            return {
                instructions: [], // Empty array since we're not decompiling
                sendyFeeLamports: BigInt(sendyFeeLamports || 0),
                poolAddress: undefined, // Cannot determine pool address without decompiling
                // Return the original transaction object using the expected internal key
                _raydiumVersionedTx: raydiumTransaction
            };

        } catch (error) {
            console.error("Error calling raydiumSwap.getSwapTransaction:", error);
            throw new Error(`Raydium transaction generation failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
} 