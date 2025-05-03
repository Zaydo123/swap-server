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
import { TransactionProps, GenerateInstructionsResult } from '../base/ISwapStrategy';
import { ISwapStrategy, SwapStrategyDependencies } from '../base/ISwapStrategy';
import { Buffer } from 'buffer';
import { ensureUserTokenAccounts } from '../utils/ensureTokenAccounts';

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

// Helper to derive the PumpSwap pool PDA from the base and quote mint addresses
function derivePumpSwapPoolPDA(baseMint: string, quoteMint: string): PublicKey {
    return PublicKey.findProgramAddressSync(
        [
            Buffer.from('pool'),
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
            console.log("Checking PumpSwapStrategy eligibility via API:", pumpswapCheckURL);
            const pumpswapResponse = await fetch(pumpswapCheckURL);
    
            if (pumpswapResponse.ok) {
                const data = await pumpswapResponse.json();
                // Ensure the response contains the necessary pool address for swapping
                if (data && data.address) {
                    console.log(`PumpSwapStrategy CAN handle token ${tokenMint} via pool ${data.address}`);
                    return true;
                } else {
                    console.log(`PumpSwapStrategy API response OK but missing address for ${tokenMint}, cannot handle.`);
                    return false; // Cannot proceed without pool address from API
                }
            } else {
                // If the API check fails (404 or other error), this strategy cannot handle it,
                // as generateSwapInstructions relies on data from this endpoint.
                console.log(`PumpSwapStrategy cannot handle: API check failed (${pumpswapResponse.status}) for ${tokenMint}.`);
                return false;
            }
        } catch (error) {
            console.error(`Error during PumpSwapStrategy eligibility check for ${tokenMint}:`, error);
            return false; // Network errors, etc., mean we can't confirm eligibility
        }
        // Removed the overly optimistic fallback logic
    }

    async generateSwapInstructions(
        transactionDetails: TransactionProps,
        dependencies: SwapStrategyDependencies
    ): Promise<GenerateInstructionsResult> {
        console.log('--- Generating PumpSwap Swap Instructions using Direct Transaction Building ---');
        const { connection } = dependencies;
        const { type, amount, slippageBps, userWalletAddress, inputMint, outputMint } = transactionDetails.params;

        // Ensure the user has ATAs for input and output mints
        const preparatoryInstructions: TransactionInstruction[] = [];
        const mintsToEnsure = Array.from(new Set([inputMint, outputMint]))
            .map((s) => new PublicKey(s));
        await ensureUserTokenAccounts({
            connection,
            userPublicKey: new PublicKey(userWalletAddress),
            mints: mintsToEnsure,
            preparatoryInstructions
        });

        // --- WRAP SOL IF NEEDED (for buy with SOL) ---
        if (type === 'buy' && inputMint === "So11111111111111111111111111111111111111112") {
            const userQuoteTokenAccount = getAssociatedTokenAddressSync(
                new PublicKey("So11111111111111111111111111111111111111112"),
                new PublicKey(userWalletAddress)
            );
            const solAmountIn = BigInt(Math.floor(Number(amount) * Number(LAMPORTS_PER_SOL)));
            const wsolAccountInfo = await connection.getAccountInfo(userQuoteTokenAccount);
            let requiredLamports = solAmountIn;

            if (!wsolAccountInfo) {
                // Account does not exist, must fund with rent-exemption + swap amount
                const rentExempt = BigInt(await connection.getMinimumBalanceForRentExemption(165));
                requiredLamports = solAmountIn + rentExempt;
            } else if (BigInt(wsolAccountInfo.lamports) < solAmountIn) {
                // Account exists, but not enough lamports
                requiredLamports = solAmountIn - BigInt(wsolAccountInfo.lamports);
            } else {
                requiredLamports = 0n; // Already enough
            }

            if (requiredLamports > 0n) {
                preparatoryInstructions.push(
                    SystemProgram.transfer({
                        fromPubkey: new PublicKey(userWalletAddress),
                        toPubkey: userQuoteTokenAccount,
                        lamports: Number(requiredLamports),
                    })
                );
                preparatoryInstructions.push(
                    createSyncNativeInstruction(userQuoteTokenAccount)
                );
            }
        }

        // --- ENSURE WSOL ATA EXISTS FOR SELL (for receiving SOL as WSOL) ---
        if (type === 'sell' && outputMint === "So11111111111111111111111111111111111111112") {
            const userWSOLAccount = getAssociatedTokenAddressSync(
                NATIVE_MINT,
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
                        NATIVE_MINT
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

        // Fetch pool data for decimals and reserves
        let poolData: any;
        let apiQuoteMint: string = "So11111111111111111111111111111111111111112"; // default to WSOL
        try {
            const pumpswapPoolURL = `https://swap-api.pump.fun/v1/pools/pump-pool?base=${inputMint}`;
            const response = await fetch(pumpswapPoolURL);
            if (!response.ok) {
                // If the primary lookup fails, we cannot proceed as we need pool data
                throw new Error(`Failed to fetch required pool data for ${inputMint}. Status: ${response.status}`);
            }
            poolData = await response.json();
            console.log('Successfully fetched pool data via base mint lookup.');
            
            if (!poolData || poolData.baseMintDecimals == null || poolData.quoteMintDecimals == null ||
                poolData.baseReserves == null || poolData.quoteReserves == null) {
                throw new Error("Incomplete pool data (missing decimals or reserves)");
            }
            if (poolData.quoteMint) {
                apiQuoteMint = poolData.quoteMint;
            }
        } catch (error) {
            console.error("Error fetching pool data:", error);
            throw new Error(`Could not fetch pool data for ${inputMint}: ${error instanceof Error ? error.message : String(error)}`);
        }

        // Use the pool PDA/address from the API response
        const baseMint = new PublicKey(inputMint);
        const quoteMint = new PublicKey(apiQuoteMint);
        const pool = new PublicKey(poolData.address);
        // Log the API's pool address for confirmation
        if (poolData.address) {
            console.log("API pool address:", poolData.address);
        }
        const userPublicKey = new PublicKey(userWalletAddress);

        const baseDecimals = poolData.baseMintDecimals;
        const quoteDecimals = poolData.quoteMintDecimals; // Should be 9 for SOL
        const baseReserves = BigInt(String(poolData.baseReserves));
        const quoteReserves = BigInt(String(poolData.quoteReserves));

        let tokenAmount: bigint = 0n;
        let solAmount: bigint = 0n;
        let sendyFeeLamports: bigint = 0n;

        // Convert slippage from basis points to percentage
        const slippagePercentage = Number(slippageBps) / 100;

        if (type === 'buy') {
            // Buying token with SOL
            if (inputMint === "So11111111111111111111111111111111111111112") {
                // Input: SOL amount. Calculate min token out.
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
                
                console.log(`PumpSwap Buy (SOL Input): SOL In = ${solAmountIn}, Min Token Out = ${minBaseAmountOut}, Fee = ${sendyFeeLamports}`);
            } else {
                // Input: Token amount. Calculate max SOL in.
                const baseAmountOut = BigInt(Math.floor(Number(amount) * Math.pow(10, Number(baseDecimals))));
                
                // Ensure amount doesn't exceed pool reserves
                if (baseAmountOut >= baseReserves) {
                    throw new Error("Desired token amount exceeds pool reserves");
                }
                
                // Calculate expected SOL in using constant product formula
                const k = baseReserves * quoteReserves;
                const newBaseReserves = baseReserves - baseAmountOut;
                const newQuoteReserves = k / newBaseReserves;
                const quoteAmountIn = newQuoteReserves - quoteReserves;
                
                // Apply slippage tolerance
                const maxQuoteAmountIn = quoteAmountIn + (quoteAmountIn * BigInt(Math.floor(slippagePercentage * 100))) / 10000n;
                
                // Set values for transaction
                tokenAmount = baseAmountOut;
                solAmount = maxQuoteAmountIn;
                
                // Calculate Sendy fee (1% of max SOL input)
                sendyFeeLamports = maxQuoteAmountIn / 100n;
                
                console.log(`PumpSwap Buy (Token Output): Max SOL In = ${maxQuoteAmountIn}, Token Out = ${baseAmountOut}, Fee = ${sendyFeeLamports}`);
            }
        } else if (type === 'sell') {
            // Selling token for SOL
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
            
            console.log(`PumpSwap Sell: Token In = ${baseAmountIn}, Min SOL Out = ${minQuoteAmountOut}, Fee = ${sendyFeeLamports}`);
        }

        // Derive PDA addresses - NO, use hardcoded addresses from pumpswap.ts
        const globalConfig = GLOBAL_CONFIG_PDA;
        const eventAuthority = EVENT_AUTHORITY_PDA;

        // Get token accounts
        const userBaseTokenAccount = getAssociatedTokenAddressSync(baseMint, userPublicKey);
        const userQuoteTokenAccount = getAssociatedTokenAddressSync(quoteMint, userPublicKey);
        
        // Get pool token accounts using standard ATA derivation (like in pumpswap.ts)
        const poolBaseTokenAccount = getAssociatedTokenAddressSync(
            baseMint, // Mint
            pool,     // Owner (the pool address)
            true      // Allow owner off-curve (required for PDAs/Contracts as owners)
        );
        
        const poolQuoteTokenAccount = getAssociatedTokenAddressSync(
            quoteMint, // Mint (NATIVE_MINT)
            pool,      // Owner (the pool address)
            true       // Allow owner off-curve
        );
        
        // Use hardcoded protocol fee recipient ATA from pumpswap.ts
        const protocolFeeRecipientTokenAccount = FEE_RECIPIENT_ATA;

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
                console.error("Error writing token amounts:", err);
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
                console.error("Error writing token amounts:", err);
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
            ],
            data: instructionData
        });

        // All instructions, with preparatory instructions first
        const allInstructions = [...preparatoryInstructions, swapInstruction];

        // Log all key addresses before building the instruction
        console.log({
            pool: pool.toBase58(),
            baseMint: baseMint.toBase58(),
            quoteMint: quoteMint.toBase58(),
            userBaseTokenAccount: userBaseTokenAccount.toBase58(),
            userQuoteTokenAccount: userQuoteTokenAccount.toBase58(),
            poolBaseTokenAccount: poolBaseTokenAccount.toBase58(),
            poolQuoteTokenAccount: poolQuoteTokenAccount.toBase58(),
        });

        console.log('PumpSwap instructions created successfully');
        return {
            success: true,
            instructions: allInstructions,
            sendyFeeLamports: sendyFeeLamports,
            poolAddress: pool
        };
    }
} 