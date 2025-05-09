import { PublicKey, TransactionInstruction, ComputeBudgetProgram, SystemProgram } from '@solana/web3.js';
import { Environment, FixedSide, Moonshot } from '@wen-moon-ser/moonshot-sdk';
import { LAMPORTS_PER_SOL } from '@solana/web3.js';
import { ISwapStrategy, GenerateInstructionsResult, SwapStrategyDependencies, TransactionProps } from '../base/ISwapStrategy';
import { NATIVE_MINT } from '@solana/spl-token';
import { prepareTokenAccounts } from '../../../utils/tokenAccounts';
import { calculateSendyFee, makeSendyFeeInstruction } from '../../../utils/feeUtils';
import { addWsolUnwrapInstructionIfNeeded } from '../../../utils/tokenAccounts';
import { FEE_RECIPIENT, SENDY_FEE_ACCOUNT } from '../../constants';
import { addCloseTokenAccountInstructionIfSellAll } from '../../../utils/tokenAccounts';

export class MoonshotSwapStrategy implements ISwapStrategy {
    // Note: Moonshot SDK instance is created within generateSwapInstructions now
    // to ensure the correct rpcUrl from dependencies is used.

    constructor() {
       // No initialization needed here if done dynamically in methods
    }

    // Simple check based on suffix, might need refinement
    async canHandle(
        transactionDetails: TransactionProps,
        dependencies: SwapStrategyDependencies
    ): Promise<boolean> {
        const { inputMint, outputMint, type } = transactionDetails.params;
        const tokenMint = type === 'buy' ? outputMint : inputMint;
        // Check if the mint address ends with 'moon'
        const isMoonToken = tokenMint.endsWith('moon');
        if (!isMoonToken) {
            return false;
        }

        // Further check: ensure it's not migrated, but allow handling even if API fails
        try {
            // console.log("Checking MoonshotStrategy eligibility for:", tokenMint);
            
            // First try the moonshot API
            const response = await fetch(`https://api.moonshot.cc/token/v1/solana/${tokenMint}`);
            
            if (response.ok) {
                const data = await response.json();
                const isMigrated = data.moonshot?.progress == 100;

                if (isMigrated) {
                    // console.log("MoonshotStrategy: Token is migrated, cannot handle.");
                    return false; // Should be handled by Raydium or other strategy
                } else {
                    // console.log("MoonshotStrategy: Token is not migrated, CAN handle.");
                    return true; // Not migrated, this strategy applies
                }
            }
            
            // If moonshot API failed, try checking with dexscreener API as fallback
            const dexscreenerUrl = `https://api.dexscreener.com/latest/dex/tokens/${tokenMint}`;
            const dexResponse = await fetch(dexscreenerUrl);
            
            if (dexResponse.ok) {
                const dexData = await dexResponse.json();
                // Check if we have pairs and if the first pair has moonshot data with progress 100
                if (dexData.pairs && dexData.pairs.length > 0 && 
                    dexData.pairs[0].moonshot && dexData.pairs[0].moonshot.progress === 100) {
                    console.log("MoonshotStrategy: DexScreener shows token is migrated, cannot handle.");
                    return false;
                }
            }
            
            // If both APIs fail or don't confirm migration, allow handling based on suffix
            // console.warn(`MoonshotStrategy: Could not definitively confirm migration status, allowing handle based on suffix.`);
            return true;
                
        } catch (error) {
             console.error("MoonshotStrategy: Error during eligibility check:", error);
             // If there's a network/fetch error, still attempt to handle based on suffix.
             //console.warn("MoonshotStrategy: Allowing handle based on suffix despite fetch error.");
             return true;
        }
    }

    /**
     * Generates all instructions required for a Moonshot swap, including:
     *   - Fee transfer (if needed)
     *   - The swap instruction(s) from Moonshot SDK
     * All instructions are returned in a single array, in the correct order, for bundling into a single transaction.
     * No setup or side-effect instructions are sent outside this transaction.
     */
    async generateSwapInstructions(
        transactionDetails: TransactionProps,
        dependencies: SwapStrategyDependencies // Use dependencies for connection, rpcUrl etc.
    ): Promise<GenerateInstructionsResult> {
        // console.log('--- Generating Moonshot Swap Instructions ---');

        // Use dependencies for connection, rpcUrl etc.
        const { connection, rpcUrl } = dependencies;

        // Initialize moonshot with the correct RPC URL from dependencies
        const moonshot = new Moonshot({
            rpcUrl,
            environment: Environment.MAINNET,
            chainOptions: {
                solana: { confirmOptions: { commitment: 'confirmed' } },
            },
        });

        const { inputMint, outputMint, type } = transactionDetails.params;
        const tokenAddress = new PublicKey(type === 'buy' ? outputMint : inputMint);
        let sendyFeeLamports: bigint = 0n;

        // console.log('Fetching token instance...');
        const tokenObj = moonshot.Token({
            mintAddress: tokenAddress.toString(),
        });
        // console.log('Token instance fetched successfully');

        // console.log('Proceeding with bonding curve logic (assuming not migrated).');
        let tokenAmount: bigint;
        let collateralAmount: bigint;
        let swapInstructions: TransactionInstruction[] = [];

        if (transactionDetails.params.type === 'buy') {
            if (transactionDetails.params.inputMint === NATIVE_MINT.toString()) {
                // Convert from SOL to lamports and then to BigInt
                const solAmount = Number(transactionDetails.params.amount);
                const collateralLamports = BigInt(Math.floor(solAmount * LAMPORTS_PER_SOL));
                collateralAmount = collateralLamports;
                
                try {
                    tokenAmount = await tokenObj.getTokenAmountByCollateral({
                        collateralAmount,
                        tradeDirection: 'BUY',
                    });
                } catch (error) {
                    console.error("Error calculating token amount:", error);
                    throw error;
                }
                
                // console.log('Moonshot BUY (SOL input):', {
                //     originalSolAmount: solAmount,
                //     convertedLamports: collateralLamports.toString()
                // });
            } else {
                // Amount is in token units - Assuming 9 decimals for Moonshot tokens based on original code
                const decimals = 9n;
                const tokenAmountNumber = Number(transactionDetails.params.amount);
                tokenAmount = BigInt(Math.floor(tokenAmountNumber * (10 ** Number(decimals))));
                
                try {
                    collateralAmount = await tokenObj.getCollateralAmountByTokens({
                        tokenAmount,
                        tradeDirection: 'BUY',
                    });
                } catch (error) {
                    console.error("Error calculating collateral amount:", error);
                    throw error;
                }
                
                // console.log('Moonshot BUY (Token output):', {
                //     originalTokenAmount: tokenAmountNumber,
                //     convertedTokenAmount: tokenAmount.toString()
                // });
            }

            // Calculate fee *after* determining final collateral amount
            sendyFeeLamports = calculateSendyFee(collateralAmount);

            try {
                const { ixs } = await tokenObj.prepareIxs({
                    slippageBps: transactionDetails.params.slippageBps,
                    creatorPK: transactionDetails.params.userWalletAddress,
                    tokenAmount,
                    collateralAmount,
                    tradeDirection: 'BUY',
                    fixedSide: transactionDetails.params.inputMint === NATIVE_MINT.toString() ? FixedSide.IN : FixedSide.OUT,
                });
                swapInstructions = ixs;
                // console.log('Moonshot BUY instructions prepared.');
            } catch (error) {
                console.error("Error preparing BUY instructions:", error);
                throw error;
            }
        } else { // Sell
            // Assuming 9 decimals for Moonshot tokens based on original code
            const decimals = 9n;
            const tokenAmountNumber = Number(transactionDetails.params.amount);
            tokenAmount = BigInt(Math.floor(tokenAmountNumber * (10 ** Number(decimals))));

            // console.log('Moonshot token amount for selling:', {
            //     originalAmount: tokenAmountNumber,
            //     convertedAmount: tokenAmount.toString(),
            //     decimals: decimals.toString()
            // });

            try {
                collateralAmount = await tokenObj.getCollateralAmountByTokens({
                    tokenAmount,
                    tradeDirection: 'SELL',
                });
            } catch (error) {
                console.error("Error calculating SOL output:", error);
                throw error;
            }

            // Calculate fee based on collateral amount received
            sendyFeeLamports = calculateSendyFee(collateralAmount);

            try {
                const { ixs } = await tokenObj.prepareIxs({
                    slippageBps: transactionDetails.params.slippageBps,
                    creatorPK: transactionDetails.params.userWalletAddress,
                    tokenAmount, // Input amount is fixed
                    collateralAmount, // This will be the minimum collateral out based on slippage
                    tradeDirection: 'SELL',
                    fixedSide: FixedSide.IN, // FixedSide is IN for sell (fixing the input token amount)
                });
                swapInstructions = ixs;
                // console.log('Moonshot SELL instructions prepared.');
            } catch (error) {
                console.error("Error preparing SELL instructions:", error);
                throw error;
            }
        }

        // --- Fee Transfer Instruction ---
        let feeInstruction: TransactionInstruction | undefined = undefined;
        if (sendyFeeLamports > 0n) {
            feeInstruction = makeSendyFeeInstruction({
                from: new PublicKey(transactionDetails.params.userWalletAddress),
                to: SENDY_FEE_ACCOUNT,
                lamports: Number(sendyFeeLamports),
            });
        }

        // --- Concatenate all instructions in correct order ---
        const allInstructions: TransactionInstruction[] = [
            ...(feeInstruction ? [feeInstruction] : []),
            ...swapInstructions,
        ];

        // Add WSOL unwrap instruction if needed (shared utility)
        await addWsolUnwrapInstructionIfNeeded({
            outputMint: transactionDetails.params.outputMint,
            userPublicKey: new PublicKey(transactionDetails.params.userWalletAddress),
            instructions: allInstructions,
            connection: connection
        });

        // Add close token account instruction if selling all tokens
        if (transactionDetails.params.type === 'sell') {
            await addCloseTokenAccountInstructionIfSellAll({
                connection,
                inputMint: transactionDetails.params.inputMint,
                amount: transactionDetails.params.amount,
                userPublicKey: new PublicKey(transactionDetails.params.userWalletAddress),
                instructions: allInstructions,
                isSellOperation: true
            });
        }

        return {
            success: true,
            instructions: allInstructions,
            sendyFeeLamports: Number(sendyFeeLamports),
            poolAddress: undefined // Cannot determine pool address without API data
        };
    }
} 