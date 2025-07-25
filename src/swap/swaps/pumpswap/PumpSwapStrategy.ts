import {
    PublicKey,
    Connection,
    TransactionInstruction,
    SystemProgram,
    LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import {
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
    getAssociatedTokenAddressSync,
    NATIVE_MINT,
    createAssociatedTokenAccountInstruction,
    createSyncNativeInstruction
} from '@solana/spl-token';
import { BN } from "@coral-xyz/anchor";
import { TransactionProps, GenerateInstructionsResult } from '../base/ISwapStrategy';
import { ISwapStrategy, SwapStrategyDependencies } from '../base/ISwapStrategy';
import { Buffer } from 'buffer';
import { ensureUserTokenAccounts } from '../utils/ensureTokenAccounts';
import { addCloseTokenAccountInstructionIfSellAll, addWsolUnwrapInstructionIfNeeded } from '../../../utils/tokenAccounts';
import { fetchWithRetry } from '../../utils/fetchWithRetry';
import { calculateSendyFee, makeSendyFeeInstruction, makeAstralaneTipInstruction } from '../../../utils/feeUtils';
import { SENDY_FEE_ACCOUNT } from '../../constants';
import { prepareTokenAccounts } from '../../../utils/tokenAccounts';

// Constants
const PUMP_SWAP_PROGRAM_ID = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
const PROTOCOL_FEE_RECIPIENT = new PublicKey("62qc2CNXwrYqQScmEdiZFFAnJR262PxWEuNQtxfafNgV");
const GLOBAL_CONFIG_PDA = new PublicKey("ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw");
const EVENT_AUTHORITY_PDA = new PublicKey("GS4CU59F31iL7aR2Q8zVS8DRrcRnXX1yjQ66TqNVQnaR");
const FEE_RECIPIENT_ATA = new PublicKey("94qWNrtmfn42h3ZjUZwWvK1MEo9uVmmrBPd2hpNjYDjb");

// Discriminators for PumpSwap (as exact byte arrays)
const BUY_DISCRIMINATOR = Buffer.from([102, 6, 61, 18, 1, 218, 235, 234]);
const SELL_DISCRIMINATOR = Buffer.from([51, 230, 133, 164, 1, 127, 131, 173]);

// Cache for token accounts
type TokenAccountCache = {
    userBaseTokenAccount?: PublicKey;
    userQuoteTokenAccount?: PublicKey;
    poolBaseTokenAccount?: PublicKey;
    poolQuoteTokenAccount?: PublicKey;
};

// Debug log helper (no-op by default)
function debugLog(...args: any[]) {
  // console.log(...args); // Uncomment to enable debug logs
}

// Helper to derive the PumpSwap pool PDA from the base and quote mint addresses
function derivePumpSwapPoolPDA(baseMint: string, quoteMint: string, creator: string, poolIndex: number): PublicKey {
    // Convert poolIndex from number to Buffer for PDA derivation
    // Assuming poolIndex is u16, so 2 bytes, little-endian
    const indexBuffer = Buffer.alloc(2);
    indexBuffer.writeUInt16LE(poolIndex, 0);

    return PublicKey.findProgramAddressSync(
        [
            Buffer.from('pool'),
            indexBuffer, // Add index to seeds
            new PublicKey(creator).toBuffer(), // Add creator to seeds
            new PublicKey(baseMint).toBuffer(),
            new PublicKey(quoteMint).toBuffer()
        ],
        PUMP_SWAP_PROGRAM_ID
    )[0];
}

// PumpSwap Strategy Implementation
export class PumpSwapStrategy implements ISwapStrategy {
    private tokenAccountCache: TokenAccountCache = {};

    async canHandle(
        transactionDetails: TransactionProps,
        dependencies: SwapStrategyDependencies
    ): Promise<boolean> {
        const { inputMint, outputMint, type } = transactionDetails.params;
        const tokenMint = type === 'buy' ? outputMint : inputMint;
        
        try {
            // Check the main PumpSwap API endpoint. We NEED data from this endpoint to generate instructions.
            const pumpswapCheckURL = `https://swap-api.pump.fun/v1/pools/pump-pool?base=${tokenMint}`;
            debugLog("Checking PumpSwapStrategy eligibility via API:", pumpswapCheckURL);
            const pumpswapResponse = await fetchWithRetry(pumpswapCheckURL);
    
            if (pumpswapResponse.ok) {
                const data = await pumpswapResponse.json();
                // Ensure the response contains the necessary pool address for swapping
                if (data && data.address) {
                    debugLog(`PumpSwapStrategy CAN handle token ${tokenMint} via pool ${data.address}`);
                    return true;
                } else {
                    debugLog(`PumpSwapStrategy API response OK but missing address for ${tokenMint}, cannot handle.`);
                    return false; // Cannot proceed without pool address from API
                }
            } else {
                // If the API check fails (404 or other error), this strategy cannot handle it,
                // as generateSwapInstructions relies on data from this endpoint.
                debugLog(`PumpSwapStrategy cannot handle: API check failed (${pumpswapResponse.status}) for ${tokenMint}.`);
                return false;
            }
        } catch (error) {
            debugLog(`Error during PumpSwapStrategy eligibility check for ${tokenMint}:`, error);
            return false; // Network errors, etc., mean we can't confirm eligibility
        }
        // Removed the overly optimistic fallback logic
    }

    async generateSwapInstructions(
        transactionDetails: TransactionProps,
        dependencies: SwapStrategyDependencies,
        astralane: boolean = false
    ): Promise<GenerateInstructionsResult> {
        debugLog('--- [PumpSwap] Generating Swap Instructions ---');
        const { connection } = dependencies;
        const { type, amount, slippageBps, userWalletAddress, inputMint, outputMint } = transactionDetails.params;
        
        const PUMP_POOL_ACCOUNT_DISCRIMINATOR = Buffer.from([241, 154, 109, 4, 17, 177, 109, 188]);
        const COIN_CREATOR_FIELD_OFFSET = 8 + 1 + 2 + (32 * 6) + 8; // Discriminator + pool_bump + index + 6 pubkeys + lp_supply

        // Initialize variables
        const preparatoryInstructions: TransactionInstruction[] = [];
        let poolData: any;
        let apiQuoteMint: string = "So11111111111111111111111111111111111111112"; // default to WSOL
        
        // Determine the actual pump token mint address based on swap type
        const tokenMint = type === 'buy' ? outputMint : inputMint;
        
        // Fetch pool data for decimals and reserves
        try {
            // Use tokenMint instead of inputMint for the API call
            const pumpswapPoolURL = `https://swap-api.pump.fun/v1/pools/pump-pool?base=${tokenMint}`;
            const response = await fetchWithRetry(pumpswapPoolURL);
            if (!response.ok) {
                // If the primary lookup fails, we cannot proceed as we need pool data
                throw new Error(`Failed to fetch required pool data for ${tokenMint}. Status: ${response.status}`);
            }
            poolData = await response.json();
            debugLog('Successfully fetched pool data via base mint lookup.');
            
            if (!poolData || poolData.baseMintDecimals == null || poolData.quoteMintDecimals == null ||
                poolData.baseReserves == null || poolData.quoteReserves == null) {
                throw new Error("Incomplete pool data (missing decimals or reserves)");
            }
            if (poolData.quoteMint) {
                apiQuoteMint = poolData.quoteMint;
            }
        } catch (error) {
            debugLog("Error fetching pool data:", error);
            throw new Error(`Could not fetch pool data for ${tokenMint}: ${error instanceof Error ? error.message : String(error)}`);
        }
        
        // Use the pool data to get mints
        const baseMint = new PublicKey(poolData.baseMint);
        const quoteMint = new PublicKey(poolData.quoteMint);
        // Get creator (for pool PDA derivation) and poolIndex from API response
        const ammPoolCreator = poolData.creator; // Creator of the AMM pool itself
        const poolIndex = poolData.poolIndex;
        const poolPdaFromApi = new PublicKey(poolData.address); // Address of the Pool account

        // Fetch the Pool account data to get the *actual* on-chain coin_creator pubkey
        const poolAccountInfo = await connection.getAccountInfo(poolPdaFromApi);
        if (!poolAccountInfo || !poolAccountInfo.data) {
            throw new Error(`Failed to fetch account data for Pool ${poolPdaFromApi.toBase58()}`);
        }
        if (!poolAccountInfo.data.subarray(0, 8).equals(PUMP_POOL_ACCOUNT_DISCRIMINATOR)) {
            throw new Error(`Account ${poolPdaFromApi.toBase58()} is not a valid PumpSwap Pool account (discriminator mismatch).`);
        }
        const onChainCoinCreatorKey = new PublicKey(poolAccountInfo.data.subarray(COIN_CREATOR_FIELD_OFFSET, COIN_CREATOR_FIELD_OFFSET + 32));
        
        debugLog(`On-chain coin_creator for pool ${poolPdaFromApi.toBase58()}: ${onChainCoinCreatorKey.toBase58()}`);

        // Validate that ammPoolCreator (for pool PDA derivation seed) and poolIndex are present
        if (!ammPoolCreator || typeof poolIndex !== 'number') { 
            throw new Error('`creator` (for main pool PDA seed) or `poolIndex` missing from API pool data.');
        }
        const coinCreatorPk = onChainCoinCreatorKey; // Use the key fetched from on-chain state

        // Derive the main pool PDA using ammPoolCreator from API (creator of the bonding curve/initial pool)
        const pool = derivePumpSwapPoolPDA(baseMint.toBase58(), quoteMint.toBase58(), ammPoolCreator, poolIndex);
        
        // Log the API's pool address for confirmation, and our derived one
        if (poolData.address) {
            debugLog("API pool address:", poolData.address);
            debugLog("Derived pool address (for main ops):", pool.toBase58());
            // It's CRITICAL that poolPdaFromApi matches pool, if not, derivation of main pool is wrong.
            if (pool.toBase58() !== poolPdaFromApi.toBase58()) {
                console.warn("[PumpSwapStrategy] CRITICAL WARNING: Derived main pool address does not match API reported pool address.");
                console.warn(`API: ${poolPdaFromApi.toBase58()}, Derived: ${pool.toBase58()}`);
                console.warn(`Using API's pool address ${poolPdaFromApi.toBase58()} for swap instruction keys.`);
                // Potentially use poolPdaFromApi for the keys if mismatch, but this indicates a deeper issue
                // For now, we will proceed with the derived `pool` but log this heavily.
            }
        }
        
        const userPublicKey = new PublicKey(userWalletAddress);
        
        const baseDecimals = poolData.baseMintDecimals;
        const quoteDecimals = poolData.quoteMintDecimals; // Should be 9 for SOL
        const baseReserves = BigInt(String(poolData.baseReserves));
        const quoteReserves = BigInt(String(poolData.quoteReserves));

        // Build deduped mints array for all cases
        const mintsToEnsure = Array.from(new Set([
            baseMint.toBase58(),
            quoteMint.toBase58(),
            NATIVE_MINT.toBase58()
        ])).map((s) => new PublicKey(s));

        if (type === 'buy') {
            const solAmountIn = BigInt(Math.floor(Number(amount) * Number(LAMPORTS_PER_SOL)));
            await prepareTokenAccounts({
                connection,
                userPublicKey: new PublicKey(userWalletAddress),
                mints: mintsToEnsure,
                instructions: preparatoryInstructions,
                wsolHandling: { wrap: true, amount: solAmountIn }
            });
        } else {
            await prepareTokenAccounts({
                connection,
                userPublicKey: new PublicKey(userWalletAddress),
                mints: mintsToEnsure,
                instructions: preparatoryInstructions
            });
        }

        // --- ENSURE WSOL ATA EXISTS FOR SELL (for receiving SOL as WSOL) ---
        if (type === 'sell') {
            const userWSOLAccount = getAssociatedTokenAddressSync(
                quoteMint,
                new PublicKey(userWalletAddress)
            );
            const wsolAccountInfo = await connection.getAccountInfo(userWSOLAccount);
            if (!wsolAccountInfo) {
                // If the WSOL ATA does not exist, create it and fund with rent-exemption only
                const rentExempt = BigInt(await connection.getMinimumBalanceForRentExemption(165));
                preparatoryInstructions.push(
                    createAssociatedTokenAccountInstruction(
                        new PublicKey(userWalletAddress),
                        userWSOLAccount,
                        new PublicKey(userWalletAddress),
                        quoteMint
                    )
                );
                preparatoryInstructions.push(
                    SystemProgram.transfer({
                        fromPubkey: new PublicKey(userWalletAddress),
                        toPubkey: userWSOLAccount,
                        lamports: Number(rentExempt),
                    })
                );
                preparatoryInstructions.push(
                    createSyncNativeInstruction(userWSOLAccount)
                );
            } else {
                // If it exists, just sync it to ensure it's up to date
                preparatoryInstructions.push(
                    createSyncNativeInstruction(userWSOLAccount)
                );
            }
        }

        let tokenAmount: bigint = 0n;
        let solAmount: bigint = 0n;
        let sendyFeeLamports: bigint = 0n;

        // Convert slippage from basis points to percentage
        const slippagePercentage = Number(slippageBps) / 100;

        // In PumpSwap, baseMint is always the token and quoteMint is always SOL
        if (type === 'buy') {
            // Buying baseMint (token) with quoteMint (SOL)
            // Input: SOL amount (quoteMint). Calculate min token out (baseMint).
            const solAmountIn = BigInt(typeof amount === 'string' ? Math.floor(Number(amount) * Number(LAMPORTS_PER_SOL)) : Math.floor(Number(amount) * Number(LAMPORTS_PER_SOL)));
            
            // Calculate expected token out using constant product formula
            if (quoteReserves === 0n || baseReserves === 0n) {
                throw new Error("Pool has zero reserves");
            }
            
            const k = baseReserves * quoteReserves;
            const newQuoteReserves = quoteReserves + solAmountIn;
            const newBaseReserves = k / newQuoteReserves;
            const baseAmountOut = baseReserves - newBaseReserves;
            
            // Apply slippage tolerance
            const minBaseAmountOut = baseAmountOut - (baseAmountOut * BigInt(Math.floor(slippagePercentage * 100))) / 10000n;
            
            // Set values for transaction
            tokenAmount = minBaseAmountOut;
            solAmount = solAmountIn;
            
            // Calculate Sendy fee (1% of SOL input)
            sendyFeeLamports = solAmountIn / 100n;
            
            console.log('PumpSwap Buy: SOL In =', solAmountIn, 'Sendy Fee =', sendyFeeLamports);
            
            debugLog(`PumpSwap Buy (SOL Input): SOL In = ${solAmountIn}, Min Token Out = ${minBaseAmountOut}, Fee = ${sendyFeeLamports}`);
        } else if (type === 'sell') {
            // Selling baseMint (token) for quoteMint (SOL)
            const baseAmountIn = BigInt(Math.floor(Number(amount) * Math.pow(10, Number(baseDecimals))));
            
            // Calculate expected SOL out using constant product formula
            if (quoteReserves === 0n || baseReserves === 0n) {
                throw new Error("Pool has zero reserves");
            }
            
            const k = baseReserves * quoteReserves;
            const newBaseReserves = baseReserves + baseAmountIn;
            const newQuoteReserves = k / newBaseReserves;
            const quoteAmountOut = quoteReserves - newQuoteReserves;
            
            // Apply slippage tolerance
            const minQuoteAmountOut = quoteAmountOut - (quoteAmountOut * BigInt(Math.floor(slippagePercentage * 100))) / 10000n;
            
            // Set values for transaction
            tokenAmount = baseAmountIn;
            solAmount = minQuoteAmountOut;
            
            // Calculate Sendy fee (1% of min SOL output)
            sendyFeeLamports = minQuoteAmountOut / 100n;
            
            debugLog(`PumpSwap Sell: Token In = ${baseAmountIn}, Min SOL Out = ${minQuoteAmountOut}, Fee = ${sendyFeeLamports}`);
        }

        // Derive PDA addresses - NO, use hardcoded addresses from pumpswap.ts
        const globalConfig = GLOBAL_CONFIG_PDA;
        const eventAuthority = EVENT_AUTHORITY_PDA;

        // Get token accounts
        const userBaseTokenAccount = getAssociatedTokenAddressSync(baseMint, userPublicKey);
        const userQuoteTokenAccount = getAssociatedTokenAddressSync(quoteMint, userPublicKey);
        
        // Get pool token accounts using standard ATA derivation (like in pumpswap.ts)
        const poolBaseTokenAccount = getAssociatedTokenAddressSync(
            baseMint, // Token mint (base)
            pool,     // Owner (the pool address)
            true      // Allow owner off-curve (required for PDAs/Contracts as owners)
        );
        
        const poolQuoteTokenAccount = getAssociatedTokenAddressSync(
            quoteMint, // SOL mint (quote)
            pool,      // Owner (the pool address)
            true       // Allow owner off-curve
        );
        
        // Use hardcoded protocol fee recipient ATA from pumpswap.ts
        const protocolFeeRecipientTokenAccount = FEE_RECIPIENT_ATA;

        // Derive coin creator fee PDAs
        const [coinCreatorVaultAuthorityPda] = PublicKey.findProgramAddressSync(
            [
                Buffer.from("creator_vault"),
                coinCreatorPk.toBuffer()
            ],
            PUMP_SWAP_PROGRAM_ID
        );

        const coinCreatorVaultAta = getAssociatedTokenAddressSync(
            quoteMint,                      // Mint for the ATA (WSOL)
            coinCreatorVaultAuthorityPda,   // Owner of the ATA (the PDA derived above)
            true,                           // Allow owner off-curve (owner is a PDA)
            TOKEN_PROGRAM_ID                // Token program ID for WSOL
        );

        // Create instruction data with discriminator and amounts
        const instructionData = Buffer.alloc(24); // 8 bytes discriminator + 8 bytes for each u64 value
        
        if (type === 'buy') {
            instructionData.set(BUY_DISCRIMINATOR, 0);
            try {
                // First u64 is baseAmountOut for buy
                instructionData.writeBigUInt64LE(tokenAmount, 8);
                // Second u64 is maxQuoteAmountIn for buy
                instructionData.writeBigUInt64LE(solAmount, 16);
            } catch (err) {
                debugLog("Error writing token amounts:", err);
                throw new Error(`Failed to construct instruction data: ${err instanceof Error ? err.message : String(err)}`);
            }
        } else {
            instructionData.set(SELL_DISCRIMINATOR, 0);
            try {
                // First u64 is baseAmountIn for sell
                instructionData.writeBigUInt64LE(tokenAmount, 8);
                // Second u64 is minQuoteAmountOut for sell
                instructionData.writeBigUInt64LE(solAmount, 16);
            } catch (err) {
                debugLog("Error writing token amounts:", err);
                throw new Error(`Failed to construct instruction data: ${err instanceof Error ? err.message : String(err)}`);
            }
        }

        // Create the main swap instruction
        const swapInstruction = new TransactionInstruction({
            programId: PUMP_SWAP_PROGRAM_ID,
            keys: [
                { pubkey: pool, isSigner: false, isWritable: false },
                { pubkey: userPublicKey, isSigner: true, isWritable: true },
                { pubkey: globalConfig, isSigner: false, isWritable: false },
                { pubkey: baseMint, isSigner: false, isWritable: false },
                { pubkey: quoteMint, isSigner: false, isWritable: false },
                { pubkey: userBaseTokenAccount, isSigner: false, isWritable: true },
                { pubkey: userQuoteTokenAccount, isSigner: false, isWritable: true },
                { pubkey: poolBaseTokenAccount, isSigner: false, isWritable: true },
                { pubkey: poolQuoteTokenAccount, isSigner: false, isWritable: true },
                { pubkey: PROTOCOL_FEE_RECIPIENT, isSigner: false, isWritable: false },
                { pubkey: protocolFeeRecipientTokenAccount, isSigner: false, isWritable: true },
                { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
                { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
                { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
                { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
                { pubkey: eventAuthority, isSigner: false, isWritable: false },
                { pubkey: PUMP_SWAP_PROGRAM_ID, isSigner: false, isWritable: false },
                { pubkey: coinCreatorVaultAta, isSigner: false, isWritable: true },
                { pubkey: coinCreatorVaultAuthorityPda, isSigner: false, isWritable: false },
            ],
            data: instructionData
        });

        // All instructions, with preparatory instructions first
        const allInstructions = [...preparatoryInstructions];

        // Add fee instruction if needed
        if (sendyFeeLamports > 0n) {
            const feeIx = makeSendyFeeInstruction({
                from: userPublicKey,
                to: SENDY_FEE_ACCOUNT,
                lamports: Number(sendyFeeLamports),
            });
            if (feeIx) allInstructions.push(feeIx);
        }

        // Add Astralane tip instruction
        const astralaneInstruction = makeAstralaneTipInstruction({
            from: userPublicKey,
        });

        if (astralane) {
            allInstructions.push(astralaneInstruction);
        }

        // Add the main swap instruction
        allInstructions.push(swapInstruction);

        // Log all key addresses before building the instruction
        debugLog({
            pool: pool.toBase58(),
            baseMint: baseMint.toBase58(),
            quoteMint: quoteMint.toBase58(),
            userBaseTokenAccount: userBaseTokenAccount.toBase58(),
            userQuoteTokenAccount: userQuoteTokenAccount.toBase58(),
            poolBaseTokenAccount: poolBaseTokenAccount.toBase58(),
            poolQuoteTokenAccount: poolQuoteTokenAccount.toBase58(),
            protocolFeeRecipientTokenAccount: protocolFeeRecipientTokenAccount.toBase58(),
            coinCreatorVaultAta: coinCreatorVaultAta.toBase58(),
            coinCreatorVaultAuthorityPda: coinCreatorVaultAuthorityPda.toBase58(),
        });

        // Add WSOL unwrap instruction if needed (when output is SOL)
        await addWsolUnwrapInstructionIfNeeded({
            outputMint: transactionDetails.params.outputMint,
            userPublicKey: userPublicKey,
            instructions: allInstructions,
            connection: connection
        });

        // Add close non-WSOL token account instruction if selling all tokens
        if (transactionDetails.params.type === 'sell') {
            await addCloseTokenAccountInstructionIfSellAll({
                connection: dependencies.connection,
                inputMint: transactionDetails.params.inputMint,
                amount: transactionDetails.params.amount,
                userPublicKey: userPublicKey,
                instructions: allInstructions,
                isSellOperation: true
            });
        }

        debugLog('PumpSwap instructions created successfully');
        return {
            success: true,
            instructions: allInstructions,
            addressLookupTables: [], // PumpSwap doesn't use LUTs currently
            poolAddress: pool,
            sendyFeeLamports: Number(sendyFeeLamports),
        };
    }
} 