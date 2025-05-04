import { PublicKey, TransactionInstruction, Connection, Keypair } from '@solana/web3.js';
import { Raydium } from '@raydium-io/raydium-sdk-v2'; 
import BN from 'bn.js';
import { ISwapStrategy, TransactionProps, GenerateInstructionsResult, SwapStrategyDependencies } from '../base/ISwapStrategy';
import { NATIVE_MINT } from '@solana/spl-token';
import { prepareTokenAccounts } from '../../../utils/tokenAccounts';
import { calculateSendyFee, makeSendyFeeInstruction } from '../../../utils/feeUtils';
import { addWsolUnwrapInstructionIfNeeded, addCloseTokenAccountInstructionIfSellAll } from '../../../utils/tokenAccounts';
import { SENDY_FEE_ACCOUNT } from '../../constants';
import { Token, TokenAmount } from '@raydium-io/raydium-sdk-v2';
import { toApiV3Token, toFeeConfig } from '@raydium-io/raydium-sdk-v2';
import { Router } from '@raydium-io/raydium-sdk-v2';
import { TxVersion } from '@raydium-io/raydium-sdk-v2';
import { LAMPORTS_PER_SOL } from '@solana/web3.js';
import axios from 'axios';
import { VersionedTransaction } from '@solana/web3.js';
import { getAssociatedTokenAddress, createCloseAccountInstruction } from '@solana/spl-token';
import { AddressLookupTableAccount } from '@solana/web3.js';
import { TransactionMessage, MessageV0 } from '@solana/web3.js';

// Cache for pool data to improve performance
let poolDataCache: any = null;
let poolDataCacheTimestamp: number = 0;
const POOL_CACHE_TTL = 1000 * 60 * 2; // 2 minutes

// Helper function to get token decimals
async function getTokenDecimals(connection: Connection, mint: PublicKey): Promise<number> {
  try {
    console.log(`Fetching decimals for token: ${mint.toBase58()}`);
    const info = await connection.getParsedAccountInfo(mint);
    const data = (info.value?.data as any)?.parsed;
    if (data?.type === 'mint') {
      console.log(`Found decimals: ${data.info.decimals} for token ${mint.toBase58()}`);
      return data.info.decimals;
    }
    console.warn(`Could not parse decimals for ${mint.toBase58()}, using default of 9`);
    return 9; // Default fallback
  } catch (e) {
    console.warn(`Failed to get token decimals for ${mint.toBase58()}:`, e);
    return 9; // Default fallback
  }
}

const SOL_MINT = 'So11111111111111111111111111111111111111112';

export class RaydiumSwapStrategy implements ISwapStrategy {

    async canHandle(
        transactionDetails: TransactionProps,
        dependencies: SwapStrategyDependencies
    ): Promise<boolean> {
        const { inputMint, outputMint, type } = transactionDetails.params;
        const tokenMint = type === 'buy' ? outputMint : inputMint;
        console.log("Checking RaydiumStrategy eligibility for token mint:", tokenMint);

        // Check for Pump.fun tokens first
        if (tokenMint.toLowerCase().includes('pump')) {
            console.log(`RaydiumStrategy: Detected pump token ${tokenMint}, checking details...`);
            try {
                const dataURL = `https://frontend-api-v3.pump.fun/coins/${tokenMint}`;
                const response = await fetch(dataURL);
                if (!response.ok) {
                    console.warn(`RaydiumStrategy: Failed to fetch pump.fun data for ${tokenMint} (${response.status}). Rejecting.`);
                    return false; // Cannot verify, reject
                }
                const data = await response.json();

                // Condition: Can handle if it HAS a raydium_pool AND was created BEFORE the cutoff timestamp
                const hasRaydiumPool = !!data.raydium_pool;
                const createdTimestamp = data.created_timestamp;
                const isBeforeCutoff = createdTimestamp && createdTimestamp < 1742234121000;

                if (hasRaydiumPool && isBeforeCutoff) {
                    console.log(`RaydiumStrategy: Pump token ${tokenMint} has Raydium pool (${data.raydium_pool}) and created before cutoff (${new Date(createdTimestamp).toISOString()}). CAN handle.`);
                    return true; // Old, migrated pump token with a Raydium pool
                } else {
                    console.log(`RaydiumStrategy: Pump token ${tokenMint} does not meet Raydium criteria (hasRaydiumPool: ${hasRaydiumPool}, isBeforeCutoff: ${isBeforeCutoff}). Rejecting.`);
                    return false; // Newer pump token or one without Raydium pool
                }
            } catch (error) {
                console.error(`RaydiumStrategy: Error checking pump.fun details for ${tokenMint}:`, error);
                return false; // Error during check, reject
            }
        }

        // Check for Moonshot tokens
        if (tokenMint.toLowerCase().includes('moon')) {
            console.log(`RaydiumStrategy: Detected moon token ${tokenMint}, checking migration...`);
            try {
                const response = await fetch(`https://api.moonshot.cc/token/v1/solana/${tokenMint}`);
                 if (!response.ok) {
                    console.warn(`RaydiumStrategy: Failed to fetch moonshot data for ${tokenMint} (${response.status}). Rejecting.`);
                    return false; // Cannot verify, reject
                }
                const data = await response.json();
                const isMigrated = data?.moonshot?.progress === 100;

                if (isMigrated) {
                    console.log(`RaydiumStrategy: Moon token ${tokenMint} is fully migrated. CAN handle.`);
                    
                    // Check if it has a pairAddress we can use
                    if (data.pairAddress) {
                        console.log(`RaydiumStrategy: Migrated moon token has pairAddress: ${data.pairAddress}`);
                    }
                    
                    return true; // Raydium handles fully migrated Moonshot tokens
                } else {
                    console.log(`RaydiumStrategy: Moon token ${tokenMint} is not fully migrated (progress: ${data?.moonshot?.progress}%). Rejecting.`);
                    return false; // MoonshotSwapStrategy handles non-migrated tokens
                }
            } catch (error) {
                console.error(`RaydiumStrategy: Error checking moonshot details for ${tokenMint}:`, error);
                return false; // Error during check, reject
            }
        }

        // Final check: Verify if the token exists on standard Raydium pools
        console.log(`RaydiumStrategy: Performing final check for ${tokenMint} on standard Raydium pools...`);
        try {
            // Initialize Raydium SDK instance for the check
            const raydium = await Raydium.load({ 
                connection: dependencies.connection, 
                cluster: 'mainnet', 
                disableFeatureCheck: true, // Can be true for read-only checks
            });

            // Fetch pool info using the SDK
            const poolInfo = await raydium.api.fetchPoolByMints({ 
                mint1: NATIVE_MINT.toString(), 
                mint2: tokenMint 
            });

            // Check if pool data was found
            if (poolInfo && poolInfo.data && poolInfo.data.length > 0) {
                 console.log(`RaydiumStrategy: Standard Raydium pool found for ${tokenMint}. CAN handle.`);
                 return true;
            } else {
                console.log(`RaydiumStrategy: No standard Raydium pool found for ${tokenMint} via SDK. Rejecting.`);
                return false;
            }
        } catch (error) {
             console.error(`RaydiumStrategy: Error during final Raydium pool check for ${tokenMint}:`, error);
             return false; // Error during check, reject
        }
    }

    private async getCachedPoolData(raydium: any): Promise<any> {
        const now = Date.now();
        if (poolDataCache && now - poolDataCacheTimestamp < POOL_CACHE_TTL) {
            return poolDataCache;
        }
        poolDataCache = await raydium.tradeV2.fetchRoutePoolBasicInfo();
        poolDataCacheTimestamp = now;
        return poolDataCache;
    }

    async generateSwapInstructions(
        transactionDetails: TransactionProps,
        dependencies: SwapStrategyDependencies
    ): Promise<GenerateInstructionsResult & { versionedTransaction?: VersionedTransaction }> {
        const { inputMint, outputMint, amount, slippageBps, type } = transactionDetails.params;
        const userPublicKey = dependencies.userPublicKey;
        const { connection } = dependencies;

        if (!inputMint || !outputMint || !amount || !slippageBps) {
            return { success: false, error: 'Missing required swap parameters.' };
        }

        try {
            // 1. Prepare parameters
            const isInputSol = inputMint === SOL_MINT;
            const txVersion = 'V0';
            
            // Determine correct decimals for the input token
            let amountInBaseUnits: number;
            if (isInputSol) {
                // SOL uses 9 decimals (1 SOL = 1,000,000,000 lamports)
                amountInBaseUnits = Math.floor(Number(amount) * LAMPORTS_PER_SOL);
                console.log(`Using SOL amount: ${amount} SOL = ${amountInBaseUnits} lamports`);
            } else {
                // For token input, get the correct decimals
                const inputMintPubkey = new PublicKey(inputMint);
                const decimals = await getTokenDecimals(connection, inputMintPubkey);
                amountInBaseUnits = Math.floor(Number(amount) * Math.pow(10, decimals));
                console.log(`Using ${decimals} decimals for token ${inputMint}, ${amount} tokens = ${amountInBaseUnits} base units`);
            }

            // 2. Get quote from Raydium API
            const quoteUrl = `https://transaction-v1.raydium.io/compute/swap-base-in?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountInBaseUnits}&slippageBps=${slippageBps}&txVersion=${txVersion}`;
            console.log('[Raydium API] GET', quoteUrl);
            const { data: swapResponse } = await axios.get(quoteUrl);
            if (!swapResponse || !swapResponse.data) {
                return { success: false, error: 'Failed to get quote from Raydium API.' };
            }

            // Now that swapResponse is available, check if output is SOL/WSOL
            let isOutputSol = outputMint === SOL_MINT;

            // 3. Get recommended priority fee (optional, fallback to 1000)
            let computeUnitPriceMicroLamports = '1000';
            try {
                const { data } = await axios.get('https://transaction-v1.raydium.io/priority-fee');
                if (data && data.data && data.data.default && data.data.default.h) {
                    computeUnitPriceMicroLamports = String(data.data.default.h);
                }
            } catch (e) {
                console.warn('Failed to fetch Raydium priority fee, using default 1000');
            }

            // 4. Build transaction via Raydium API
            const txBuildUrl = 'https://transaction-v1.raydium.io/transaction/swap-base-in';
            const txBuildBody: any = {
                computeUnitPriceMicroLamports,
                swapResponse,
                txVersion,
                wallet: userPublicKey.toBase58(),
                wrapSol: isInputSol,
                unwrapSol: isOutputSol,
            };
            // If not SOL, must provide inputAccount (ATA)
            if (!isInputSol) {
                // Find or create the user's ATA for inputMint
                const ata = await getAssociatedTokenAddress(new PublicKey(inputMint), userPublicKey);
                txBuildBody.inputAccount = ata.toBase58();
            }
            // Optionally, outputAccount for outputMint if not SOL
            if (!isOutputSol) {
                const ata = await getAssociatedTokenAddress(new PublicKey(outputMint), userPublicKey);
                txBuildBody.outputAccount = ata.toBase58();
            }
            console.log('[Raydium API] POST', txBuildUrl, txBuildBody);
            const { data: swapTransactions } = await axios.post(txBuildUrl, txBuildBody);
            if (!swapTransactions || !swapTransactions.data || !swapTransactions.data[0] || !swapTransactions.data[0].transaction) {
                return { success: false, error: 'Failed to get transaction from Raydium API.' };
            }

            // 5. Deserialize transaction
            const txBase64 = swapTransactions.data[0].transaction;
            const txBuffer = Buffer.from(txBase64, 'base64');
            let versionedTransaction = VersionedTransaction.deserialize(txBuffer);

            // 6. Calculate fee based on API response data
            let feeLamports = 0;
            if (isInputSol && swapResponse.data.inputAmount) { // Fee on INPUT SOL for buys
                try {
                    feeLamports = Math.floor(Number(swapResponse.data.inputAmount) * 0.01);
                    console.log(`Charging 1% fee on SOL input: ${feeLamports / LAMPORTS_PER_SOL} SOL`);
                } catch (e) {
                    console.error('Error calculating buy fee from inputAmount:', e);
                }
            } else if (!isInputSol && swapResponse.data.outputAmount) { // Fee on OUTPUT SOL for sells
                try {
                    feeLamports = Math.floor(Number(swapResponse.data.outputAmount) * 0.01);
                    console.log(`Charging 1% fee on SOL output: ${feeLamports / LAMPORTS_PER_SOL} SOL`);
                } catch (e) {
                    console.error('Error calculating sell fee from outputAmount:', e);
                }
            } else {
                console.log('Could not determine fee: input/output amount missing or not a SOL swap.');
            }
            
            // Ensure fee is an integer
            feeLamports = Number.isInteger(feeLamports) ? feeLamports : Math.floor(feeLamports);
            
            // 7. Add fee instruction directly to the transaction if needed
            if (feeLamports > 0 || type === 'sell') {
                // Get the existing message
                const message = versionedTransaction.message;
                
                // Extract lookup tables and account keys
                const lookupTableAccounts = [];
                for (const lookup of message.addressTableLookups) {
                    try {
                        const { value } = await connection.getAddressLookupTable(lookup.accountKey);
                        if (value) lookupTableAccounts.push(value);
                    } catch (err) {
                        console.warn('Failed to fetch lookup table:', err);
                    }
                }
                
                // Extract the original instructions
                const accountKeys = message.getAccountKeys({ addressLookupTableAccounts: lookupTableAccounts });
                const originalInstructions = message.compiledInstructions.map(ix => {
                    const programId = accountKeys.get(ix.programIdIndex);
                    if (!programId) throw new Error(`Program ID not found at index ${ix.programIdIndex}`);
                    
                    const keys = ix.accountKeyIndexes.map(idx => {
                        const pubkey = accountKeys.get(idx);
                        if (!pubkey) throw new Error(`Account key not found at index ${idx}`);
                        
                        return {
                            pubkey,
                            isSigner: message.isAccountSigner(idx),
                            isWritable: message.isAccountWritable(idx),
                        };
                    });
                    
                    return new TransactionInstruction({
                        programId,
                        keys,
                        data: Buffer.from(ix.data),
                    });
                });
                
                // Create an array for all instructions we'll add
                const allInstructions: TransactionInstruction[] = [];
                
                // 1. Add fee instruction if needed
                if (feeLamports > 0) {
                    const feeIx = makeSendyFeeInstruction({
                        from: userPublicKey,
                        to: SENDY_FEE_ACCOUNT,
                        lamports: feeLamports,
                    });
                    
                    if (feeIx) {
                        console.log(`Adding fee instruction of ${feeLamports} lamports to transaction`);
                        allInstructions.push(feeIx);
                    }
                }
                
                // 2. Add original instructions
                allInstructions.push(...originalInstructions);
                
                // 3. Add close token account instruction for 100% sell if needed
                if (type === 'sell' && inputMint !== 'So11111111111111111111111111111111111111112') {
                    try {
                        const mintPubkey = new PublicKey(inputMint);
                        const tokenAta = await getAssociatedTokenAddress(mintPubkey, userPublicKey);
                        
                        // Get the current token balance
                        const tokenInfo = await connection.getTokenAccountBalance(tokenAta);
                        if (tokenInfo?.value) {
                            // Parse the amount being sold
                            const amountNumber = parseFloat(amount);
                            const tokenDecimals = tokenInfo.value.decimals;
                            const amountRaw = Math.floor(amountNumber * (10 ** tokenDecimals));
                            const balanceRaw = Number(tokenInfo.value.amount);
                            
                            // Check if selling amount is equal to or greater than balance (with small buffer)
                            const buffer = balanceRaw * 0.001;
                            const isSellAll = amountRaw >= balanceRaw - buffer;
                            
                            console.log(`Checking if sell all: ${inputMint} - Selling: ${amountRaw}, Balance: ${balanceRaw}, Is sell all: ${isSellAll}`);
                            
                            if (isSellAll) {
                                console.log(`Adding close account instruction for token ${inputMint} (selling all tokens)`);
                                
                                // Add close account instruction
                                const closeIx = createCloseAccountInstruction(
                                    tokenAta,
                                    userPublicKey,
                                    userPublicKey
                                );
                                
                                allInstructions.push(closeIx);
                            }
                        }
                    } catch (error) {
                        console.error("Error checking/adding close account instruction:", error);
                    }
                }
                
                // Create a new versioned transaction
                const newMessage = new TransactionMessage({
                    payerKey: userPublicKey,
                    recentBlockhash: message.recentBlockhash,
                    instructions: allInstructions,
                }).compileToV0Message(lookupTableAccounts);
                
                versionedTransaction = new VersionedTransaction(newMessage);
            }

            // 8. Return the transaction directly along with the calculated fee
            return {
                success: true,
                versionedTransaction, // The original, unmodified transaction from Raydium
                sendyFeeLamports: feeLamports, // The calculated fee
                poolAddress: outputMint === SOL_MINT ? new PublicKey(outputMint) : undefined,
                // We're providing an empty instructions array to satisfy the interface
                // but we expect our handler to use the versionedTransaction directly
                instructions: [], 
            };
        } catch (e: any) {
            return { success: false, error: e.message };
        }
    }

    // Helper to execute a Raydium swap with a known pool ID
    private async executeRaydiumSwap(
        raydium: any,
        connection: Connection,
        poolId: string,
        inputMint: string,
        outputMint: string,
        amount: string,
        slippageBps: number,
        userPublicKey: PublicKey,
        type: string
    ): Promise<GenerateInstructionsResult> {
        try {
            console.log(`Executing Raydium swap for pool: ${poolId}`);
            
            // Fetch pool info (SDK returns { poolInfo, poolKeys, poolRpcData })
            const { poolInfo, poolKeys, poolRpcData } = await raydium.liquidity.getPoolInfoFromRpc({ poolId });
            const [baseReserve, quoteReserve, status] = [
                poolRpcData.baseReserve, 
                poolRpcData.quoteReserve, 
                poolRpcData.status.toNumber()
            ];

            // Validate input mint
            if (poolInfo.mintA.address !== inputMint && poolInfo.mintB.address !== inputMint) {
                return { success: false, error: 'Input mint does not match pool.' };
            }

            // Determine mintIn/mintOut
            const baseIn = inputMint === poolInfo.mintA.address;
            const [mintIn, mintOut] = baseIn ? [poolInfo.mintA, poolInfo.mintB] : [poolInfo.mintB, poolInfo.mintA];

            // Compute output amount using SDK
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

            // Prepare token accounts (ATAs)
            let ataInstructions: TransactionInstruction[] = [];
            await prepareTokenAccounts({
                connection,
                userPublicKey,
                mints: [new PublicKey(inputMint), new PublicKey(outputMint)],
                instructions: ataInstructions,
                wsolHandling: inputMint === NATIVE_MINT.toString() ? 
                    { wrap: true, amount: BigInt(amount) } : undefined
            });

            // Build swap instructions using SDK
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

            // Add WSOL unwrap instruction if needed (shared utility)
            if (outputMint === NATIVE_MINT.toString()) {
            await addWsolUnwrapInstructionIfNeeded({
                outputMint,
                userPublicKey,
                instructions: cleanupInstructions
            });
            }

            // Fee Instruction
            let feeInstruction: TransactionInstruction | undefined = undefined;
            
            // Calculate simple 1% fee - only on SOL swaps
            let sendyFeeLamports = 0;
            const isInputSol = inputMint === SOL_MINT;
            const isOutputSol = outputMint === SOL_MINT;
            if (isInputSol) {
                // 1% fee on SOL input
                sendyFeeLamports = Number(BigInt(amount) / 100n);
                console.log(`Charging 1% fee on SOL input: ${sendyFeeLamports / LAMPORTS_PER_SOL} SOL`);
            } else if (isOutputSol && out && out.amountOut) {
                // 1% fee on estimated SOL output
                sendyFeeLamports = Number(out.amountOut.div(new BN(100)).toNumber());
                console.log(`Charging 1% fee on SOL output: ${sendyFeeLamports / LAMPORTS_PER_SOL} SOL`);
            } else {
                console.log('No SOL directly involved, not charging fee');
            }
            
            if (sendyFeeLamports > 0) {
                feeInstruction = makeSendyFeeInstruction({
                    from: userPublicKey,
                    to: SENDY_FEE_ACCOUNT,
                    lamports: sendyFeeLamports,
                });
            }

            // Concatenate all instructions in correct order
            const allInstructions: TransactionInstruction[] = [
                ...(feeInstruction ? [feeInstruction] : []),
                ...ataInstructions,
                ...swapInstructions,
                ...(cleanupInstructions || []),
            ];

            // Add close token account instruction if selling all tokens
            if (type === 'sell') {
                await addCloseTokenAccountInstructionIfSellAll({
                    connection,
                    inputMint,
                    amount,
                    userPublicKey,
                    instructions: allInstructions,
                    isSellOperation: true
                });
            }

            return {
                success: true,
                instructions: allInstructions,
                addressLookupTables: [],
                poolAddress: new PublicKey(poolId),
                sendyFeeLamports,
            };
        } catch (error: any) {
            console.error('Error executing Raydium swap:', error);
            return { success: false, error: error.message || 'Error executing Raydium swap' };
        }
    }
}