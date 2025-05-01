import { PublicKey, TransactionInstruction, ComputeBudgetProgram } from '@solana/web3.js';
import { Environment, FixedSide, Moonshot } from '@wen-moon-ser/moonshot-sdk';
import { LAMPORTS_PER_SOL } from '@solana/web3.js';
import { TransactionProps } from '../../swap';
import { ISwapStrategy, GenerateInstructionsResult, SwapStrategyDependencies } from '../base/ISwapStrategy';
import { ensureUserTokenAccounts } from '../utils/ensureTokenAccounts';
import { NATIVE_MINT } from '@solana/spl-token';

export class MoonshotSwapStrategy implements ISwapStrategy {
    // Note: Moonshot SDK instance is created within generateSwapInstructions now
    // to ensure the correct heliusRpcUrl from dependencies is used.

    constructor() {
       // No initialization needed here if done dynamically in methods
    }

    // Simple check based on suffix, might need refinement
    async canHandle(
        transactionDetails: TransactionProps,
        dependencies: SwapStrategyDependencies // Added dependencies parameter
        ): Promise<boolean> {
         // Check if the mint address ends with 'moon'
        const mintAddress = transactionDetails.params.mintAddress;
        const isMoonToken = mintAddress.endsWith('moon');
        if (!isMoonToken) {
            return false;
        }

        // Further check: ensure it's not migrated, but allow handling even if API fails
        try {
            console.log("Checking MoonshotStrategy eligibility for:", mintAddress);
            const response = await fetch(`https://api.moonshot.cc/token/v1/solana/${mintAddress}`);
            
            if (!response.ok) {
                // If API fails (e.g., 404), still return true for a .moon token.
                // Let generateSwapInstructions handle the error more specifically.
                console.warn(`MoonshotStrategy: Failed to fetch moonshot data (${response.status}), but allowing handle based on suffix.`);
                return true; 
            }
            
            const data = await response.json();
            const isMigrated = data.moonshot.progress == 100;

            if (isMigrated) {
                console.log("MoonshotStrategy: Token is migrated, cannot handle.");
                return false; // Should be handled by Raydium or other strategy
            } else {
                 console.log("MoonshotStrategy: Token is not migrated, CAN handle.");
                return true; // Not migrated, this strategy applies
            }
        } catch (error) {
             console.error("MoonshotStrategy: Error during eligibility check:", error);
             // If there's a network/fetch error, still attempt to handle based on suffix.
             console.warn("MoonshotStrategy: Allowing handle based on suffix despite fetch error.");
             return true;
        }
    }

    async generateSwapInstructions(
        transactionDetails: TransactionProps,
        dependencies: SwapStrategyDependencies // Use dependencies for connection, rpcUrl etc.
    ): Promise<GenerateInstructionsResult> {
        console.log('--- Generating Moonshot Swap Instructions ---');

        // Initialize moonshot with the correct RPC URL from dependencies
        const moonshot = new Moonshot({
            rpcUrl: dependencies.heliusRpcUrl,
            environment: Environment.MAINNET,
            chainOptions: {
                solana: { confirmOptions: { commitment: 'confirmed' } },
            },
        });

        const tokenAddress = new PublicKey(transactionDetails.params.mintAddress);
        let sendyFeeLamports: bigint = 0n;

        // Ensure user token accounts exist for the token and WSOL (middleware)
        const userPublicKey = new PublicKey(transactionDetails.params.userWalletAddress);
        await ensureUserTokenAccounts({
            connection: dependencies.connection,
            userPublicKey,
            mints: [tokenAddress, NATIVE_MINT],
            preparatoryInstructions: []
        });

        console.log('Fetching token instance...');
        const tokenObj = moonshot.Token({
            mintAddress: tokenAddress.toString(),
        });
        console.log('Token instance fetched successfully');

        // Fetch bonding curve data - REMOVED redundant fetch. Relying on SDK methods.
        // let bondingCurveData;
        // try {
        //     const response = await fetch(`https://api.moonshot.cc/token/v1/solana/${tokenAddress.toString()}`);
        //      if (!response.ok) {
        //         throw new Error(`Failed to fetch moonshot token data (${response.status})`);
        //     }
        //     bondingCurveData = await response.json();
        //      // Double check migration status in case something changed between canHandle and now
        //      if (bondingCurveData.moonshot.progress == 100) {
        //          throw new Error("Moonshot token became migrated between eligibility check and instruction generation.");
        //      }
        // } catch (error) {
        //      console.error("Error fetching Moonshot bonding curve data:", error);
        //     throw new Error(`Could not fetch data for Moonshot token ${tokenAddress.toString()}`);
        // }

        // Assume token is not migrated as canHandle should have caught migrated tokens.
        console.log('Proceeding with bonding curve logic (assuming not migrated).');
        let tokenAmount: bigint;
        let collateralAmount: bigint;

        if (transactionDetails.params.type === 'buy') {
            if (transactionDetails.params.amountIsInSol) {
                const collateralLamports = transactionDetails.params.amount * LAMPORTS_PER_SOL;
                collateralAmount = BigInt(Math.floor(collateralLamports)); // Ensure integer lamports
                tokenAmount = await tokenObj.getTokenAmountByCollateral({
                    collateralAmount: collateralAmount,
                    tradeDirection: 'BUY',
                });
            } else {
                // Amount is in token units - Assuming 9 decimals for Moonshot tokens based on original code
                const decimals = 9n;
                tokenAmount = BigInt(Math.floor(transactionDetails.params.amount * Number(10n ** decimals)));
                 collateralAmount = await tokenObj.getCollateralAmountByTokens({
                    tokenAmount,
                    tradeDirection: 'BUY',
                });
            }

            // Calculate fee *after* determining final collateral amount
            sendyFeeLamports = collateralAmount / 100n;

            const { ixs } = await tokenObj.prepareIxs({
                slippageBps: Math.floor(transactionDetails.params.slippage * 100),
                creatorPK: transactionDetails.params.userWalletAddress,
                tokenAmount,
                collateralAmount,
                tradeDirection: 'BUY',
                // FixedSide should be IN if input amount (SOL or calculated collateral) is fixed,
                // OUT if output amount (token) is fixed.
                fixedSide: transactionDetails.params.amountIsInSol ? FixedSide.IN : FixedSide.OUT,
            });

            console.log('Moonshot BUY instructions prepared.');
             return {
                instructions: ixs,
                sendyFeeLamports: sendyFeeLamports,
                // Assuming the API provides the bonding curve address - Removed as data is not fetched
                poolAddress: undefined // Cannot determine pool address without API data
            };

        } else { // Sell
            // Assuming 9 decimals for Moonshot tokens based on original code
            const decimals = 9n;
            tokenAmount = BigInt(Math.floor(transactionDetails.params.amount * Number(10n ** decimals)));

            console.log('Moonshot token amount for selling:', {
                originalAmount: transactionDetails.params.amount,
                convertedAmount: tokenAmount.toString(),
                decimals: decimals.toString()
            });

            collateralAmount = await tokenObj.getCollateralAmountByTokens({
                tokenAmount,
                tradeDirection: 'SELL',
            });

            // Calculate fee based on collateral amount received
            sendyFeeLamports = collateralAmount / 100n;

            const { ixs } = await tokenObj.prepareIxs({
                slippageBps: Math.floor(transactionDetails.params.slippage * 100),
                creatorPK: transactionDetails.params.userWalletAddress,
                tokenAmount, // Input amount is fixed
                collateralAmount, // This will be the minimum collateral out based on slippage
                tradeDirection: 'SELL',
                fixedSide: FixedSide.IN, // FixedSide is IN for sell (fixing the input token amount)
            });

            console.log('Moonshot SELL instructions prepared.');
            return {
                instructions: ixs,
                sendyFeeLamports: sendyFeeLamports,
                 // Assuming the API provides the bonding curve address - Removed as data is not fetched
                poolAddress: undefined // Cannot determine pool address without API data
            };
        }
    }
} 