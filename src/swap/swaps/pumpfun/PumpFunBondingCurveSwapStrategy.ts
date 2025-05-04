import { PublicKey, TransactionInstruction, SystemProgram } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddress, NATIVE_MINT } from '@solana/spl-token';
import { LAMPORTS_PER_SOL } from '@solana/web3.js';
import { ISwapStrategy, SwapStrategyDependencies, TransactionProps, GenerateInstructionsResult } from '../base/ISwapStrategy';
import * as CNST from '../../constants'; // Adjust path
import { Buffer } from 'buffer';
import { prepareTokenAccounts, addWsolUnwrapInstructionIfNeeded, addCloseTokenAccountInstructionIfSellAll } from '../../../utils/tokenAccounts';
import { calculateSendyFee, makeSendyFeeInstruction } from '../../../utils/feeUtils';
import { FEE_RECIPIENT, SENDY_FEE_ACCOUNT } from '../../constants';
import { fetchWithRetry } from '../../utils/fetchWithRetry';

// Debug log helper (no-op by default)
function debugLog(...args: any[]) {
  // console.log(...args); // Uncomment to enable debug logs
}

// Helper from original swap.ts - move to utils later?
function bufferFromUInt64(value: number | string) {
    const buffer = Buffer.alloc(8);
    // Ensure the value is treated as a positive BigInt
    const bigIntValue = BigInt(String(value).replace(/['"n]/g, '')); // Remove quotes and trailing 'n' if present
    if (bigIntValue < 0n) {
        throw new Error(`Cannot buffer negative value: ${value}`);
    }
    buffer.writeBigUInt64LE(bigIntValue, 0);
    return buffer;
}

// Define the cutoff timestamp for using Raydium for older Pump tokens
const PUMP_FUN_RAYDIUM_CUTOFF_TIMESTAMP = 1742234121000;

export class PumpFunBondingCurveSwapStrategy implements ISwapStrategy {

    // Fetches data and checks conditions
    async canHandle(
        transactionDetails: TransactionProps,
        dependencies: SwapStrategyDependencies
    ): Promise<boolean> {
        const { inputMint, outputMint, type } = transactionDetails.params;
        const tokenMint = type === 'buy' ? outputMint : inputMint;
        // This strategy only handles pump tokens
        // EndsWith check removed as router might handle non-pump tokens first

        try {
            console.log("Checking PumpFunBondingCurveStrategy eligibility for:", tokenMint);

            // Fetch necessary data using helper (assuming router pre-caches)
            // Use helper functions defined in router.ts context or pass cache/fetchers via dependencies
            // For now, directly fetch here, but caching in router is better
            const pumpswapCheckURL = `https://swap-api.pump.fun/v1/pools/pump-pool?base=${tokenMint}`;
            const pumpswapResponse = await fetchWithRetry(pumpswapCheckURL);

            // 1. Check if bonded to pumpswap (if so, this strategy is NOT applicable)
            if (pumpswapResponse.ok) {
                console.log("Pump token is bonded to pumpswap, PumpFunBondingCurveStrategy cannot handle.");
                return false; // Handled by PumpSwapStrategy
            } else if (pumpswapResponse.status !== 404) {
                console.warn('Error checking pumpswap status for eligibility:', pumpswapResponse.status, await pumpswapResponse.text());
                // Treat API errors as potentially handleable by this strategy if pump swap fails, but log warning
            }

            // 2. Fetch pump.fun coin data
            const dataURL = `https://frontend-api-v3.pump.fun/coins/${tokenMint}`;
            const response = await fetchWithRetry(dataURL);
            if (!response.ok) {
                console.error(`Failed to fetch pump.fun coin data for eligibility check (${response.status})`);
                // If we can't get data, we can't confirm it's a bonding curve pump token
                return false;
            }
            
            let data: any;
            try {
                data = await response.json();
            } catch (parseError) {
                console.error(`Error parsing JSON from pump.fun API for ${tokenMint}:`, parseError);
                // If the response isn't valid JSON, it's not a valid pump.fun token for this strategy
                return false;
            }

            // Basic validation of essential bonding curve data
            if (!data.bonding_curve || !data.associated_bonding_curve || !data.mint || data.mint !== tokenMint) {
                console.log("PumpFunBondingCurveStrategy: Incomplete or mismatched pump.fun coin data.");
                return false; // Not a valid pump token for bonding curve interaction
            }

            // 3. Check if it has a Raydium pool AND was created BEFORE the cutoff
            const createdBeforeThreshold = data.created_timestamp && data.created_timestamp < PUMP_FUN_RAYDIUM_CUTOFF_TIMESTAMP;
            if (data.raydium_pool && createdBeforeThreshold) {
                console.log("Pump token has Raydium pool and is old, PumpFunBondingCurveStrategy cannot handle (should use Raydium).");
                return false; // Should be handled by Raydium strategy
            }

            // If not bonded to pumpswap, has valid bonding curve data, and doesn't meet Raydium criteria, use bonding curve.
            console.log("PumpFunBondingCurveStrategy CAN handle this token.");
            return true;

        } catch (error) {
            console.error('Error during PumpFunBondingCurveStrategy eligibility check:', error);
            return false;
        }
    }


    /**
     * Generates all instructions required for a Pump.fun bonding curve swap, including:
     *   - ATA creation (setup)
     *   - Fee transfer (if needed)
     *   - The swap instruction(s)
     * All instructions are returned in a single array, in the correct order, for bundling into a single transaction.
     * No setup or side-effect instructions are sent outside this transaction.
     */
    async generateSwapInstructions(
        transactionDetails: TransactionProps,
        dependencies: SwapStrategyDependencies
    ): Promise<GenerateInstructionsResult> {
        debugLog('--- Generating Pump.fun Bonding Curve Swap Instructions ---');
        const { connection, userPublicKey } = dependencies;
        const { type, amount, slippageBps, inputMint, outputMint } = transactionDetails.params;
        const payer = userPublicKey;
        const tokenAddress = new PublicKey(inputMint);

        // Ensure the user has ATAs for input and output mints using shared utility
        const preparatoryInstructions: TransactionInstruction[] = [];
        // Ensure ATAs for (1) the input mint, (2) WSOL (native), and (3) the actual pump token mint (needed for BUY)
        const mintsToEnsure = Array.from(new Set([
            tokenAddress,
            NATIVE_MINT,
            // Always include pumpTokenMintAddress so that BUY transactions have the user's ATA ready
            type === 'buy' ? new PublicKey(outputMint) : new PublicKey(inputMint),
        ].map((m) => m.toString()))).map((s) => new PublicKey(s));
        await prepareTokenAccounts({
            connection,
            userPublicKey: payer,
            mints: mintsToEnsure,
            instructions: preparatoryInstructions,
        });

        // Fetch pump.fun coin data
        const tokenMint = type === 'buy' ? outputMint : inputMint;
        const dataURL = `https://frontend-api-v3.pump.fun/coins/${tokenMint}`;
        let data: any;
        try {
            const response = await fetchWithRetry(dataURL);
            if (!response.ok) {
                throw new Error(`Failed to fetch pump.fun coin data: ${response.statusText}`);
            }
            const rawText = await response.text();
            try {
                data = JSON.parse(rawText);
            } catch (parseError) {
                debugLog("Error parsing JSON from pump.fun API for", tokenMint, ":", parseError);
                debugLog("Raw response was:", rawText);
                return {
                    success: false,
                    error: `Pump.fun API returned invalid data for token ${tokenMint}. Please try again later or with a different token.`
                };
            }
        } catch (error) {
            debugLog("Error fetching pump.fun data for instruction generation:", error);
            return {
                success: false,
                error: `Could not fetch data for pump.fun token ${tokenMint}: ${error instanceof Error ? error.message : String(error)}`
            };
        }

        // --- Validation (Updated) ---
        if (!data) {
            throw new Error('Fetched pump.fun data is null or undefined');
        }
        if (!data.bonding_curve || !data.associated_bonding_curve) {
            throw new Error('Invalid bonding curve addresses in pump.fun data');
        }
        if (data.virtual_sol_reserves == null || data.virtual_token_reserves == null) {
            throw new Error('Missing reserve data in pump.fun data');
        }
        if (typeof data.virtual_sol_reserves !== 'number' && typeof data.virtual_sol_reserves !== 'string') {
            throw new Error('Invalid type for virtual_sol_reserves in pump.fun data');
        }
        if (typeof data.virtual_token_reserves !== 'number' && typeof data.virtual_token_reserves !== 'string') {
            throw new Error('Invalid type for virtual_token_reserves in pump.fun data');
        }

        // --- Fetch Decimals from Mint Account ---
        let decimals: number;
        try {
            const mintInfo = await connection.getParsedAccountInfo(tokenAddress);
            if (!mintInfo.value || !('parsed' in mintInfo.value.data) || !mintInfo.value.data.parsed?.info?.decimals) {
                throw new Error('Could not parse decimal info from mint account.');
            }
            decimals = mintInfo.value.data.parsed.info.decimals;
            debugLog(`Fetched decimals for ${tokenAddress.toString()}: ${decimals}`);
        } catch(mintError) {
            debugLog(`Error fetching decimals for mint ${tokenAddress.toString()}:`, mintError);
            throw new Error(`Failed to fetch decimals for token ${tokenAddress.toString()}: ${mintError instanceof Error ? mintError.message : String(mintError)}`);
        }
        // --- End Fetch Decimals ---

        // Determine the actual pump.fun token mint address based on swap type
        const pumpTokenMintAddress = type === 'buy' ? new PublicKey(outputMint) : new PublicKey(inputMint);

        const tokenDecimalMultiplier = 10 ** decimals;

        // Derive the bonding curve PDA instead of trusting the API
        const bondingCurveSeeds = [Buffer.from('bonding-curve'), pumpTokenMintAddress.toBuffer()];
        const [derivedBondingCurve,] = PublicKey.findProgramAddressSync(bondingCurveSeeds, CNST.PUMP_FUN_PROGRAM);

        // Validate against API data (optional but recommended)
        if (data.bonding_curve && derivedBondingCurve.toBase58() !== data.bonding_curve) {
            debugLog(`Derived bonding curve PDA ${derivedBondingCurve.toBase58()} does not match API bonding curve ${data.bonding_curve} for token ${pumpTokenMintAddress.toBase58()}. Using derived PDA.`);
        }

        const BONDING_CURVE = derivedBondingCurve; // Use the derived address

        // Derive the associated bonding curve address (Token Account owned by bonding curve)
        const assocBondingCurveSeeds = [
            BONDING_CURVE.toBuffer(),
            TOKEN_PROGRAM_ID.toBuffer(),
            pumpTokenMintAddress.toBuffer(),
        ];
        const [derivedAssocBondingCurve,] = PublicKey.findProgramAddressSync(assocBondingCurveSeeds, ASSOCIATED_TOKEN_PROGRAM_ID);

        // Validate against API data (optional but recommended)
        if (data.associated_bonding_curve && derivedAssocBondingCurve.toBase58() !== data.associated_bonding_curve) {
            debugLog(`Derived associated bonding curve PDA ${derivedAssocBondingCurve.toBase58()} does not match API value ${data.associated_bonding_curve} for token ${pumpTokenMintAddress.toBase58()}. Using derived PDA.`);
        }

        const ASSOCIATED_BONDING_CURVE = derivedAssocBondingCurve; // Use the derived address

        // Get user's ATA - Pump requires allowOwnerOffCurve = true
        // This ATA is for the PUMP token
        const userAssociatedTokenAccount = await getAssociatedTokenAddress(
            pumpTokenMintAddress,
            payer,
            true // allowOwnerOffCurve = true for pump bonding curve
        );

        // Convert validated pump.fun data to BigInt safely
        const virtualSolReserves = BigInt(String(data.virtual_sol_reserves)); 
        const virtualTokenReserves = BigInt(String(data.virtual_token_reserves));
        const lampsPerSol = BigInt(LAMPORTS_PER_SOL);

        // Calculate token amount and SOL amount
        let tokenAmountRaw: bigint;
        let solAmountLamports: bigint;
        let sendyFeeLamports: bigint = 0n;
        if (type === 'buy') {
            const baseSolInput = BigInt(Math.floor(Number(amount) * LAMPORTS_PER_SOL));
            // Use exact slippage as provided by the user (in basis points)
            solAmountLamports = baseSolInput + (baseSolInput * BigInt(slippageBps)) / 10000n;
            if (virtualSolReserves === 0n) throw new Error("Pump virtual SOL reserves are zero.");
            tokenAmountRaw = (virtualTokenReserves * baseSolInput) / (virtualSolReserves + baseSolInput);
            sendyFeeLamports = solAmountLamports / 100n; // 1% fee on max SOL input
            debugLog('Pump Buy (SOL input): ', { maxSolIn: solAmountLamports, minTokenOut: tokenAmountRaw, fee: sendyFeeLamports, slippageBps });
        } else { // Sell
            // Input is token amount
            tokenAmountRaw = BigInt(Math.floor(Number(amount) * Number(tokenDecimalMultiplier)));
            debugLog('Pump Sell token amount (raw units): ', tokenAmountRaw);
            // Calculate minimum SOL output with slippage
            // sol_out = (virtual_sol_reserves * token_in) / (virtual_token_reserves + token_in)
            if (virtualTokenReserves === 0n && tokenAmountRaw === 0n) {
                // Avoid division by zero if both reserves and input are zero (though unlikely)
                solAmountLamports = 0n;
            } else if (virtualTokenReserves + tokenAmountRaw === 0n) {
                throw new Error("Denominator is zero in pump sell calculation.");
            } else {
                const expectedSolOutput = (virtualSolReserves * tokenAmountRaw) / (virtualTokenReserves + tokenAmountRaw);
                solAmountLamports = expectedSolOutput - (expectedSolOutput * BigInt(slippageBps)) / 10000n; // Subtract slippage %
            }
            sendyFeeLamports = solAmountLamports / 100n; // 1% fee on min SOL output
            debugLog('Pump Sell (Token input): ', { tokenIn: tokenAmountRaw, minSolOut: solAmountLamports, fee: sendyFeeLamports, slippageBps });
        }

        // Ensure amounts are non-negative
        tokenAmountRaw = tokenAmountRaw < 0n ? 0n : tokenAmountRaw;
        solAmountLamports = solAmountLamports < 0n ? 0n : solAmountLamports;
        sendyFeeLamports = sendyFeeLamports < 0n ? 0n : sendyFeeLamports;

        // --- Build Swap Instruction(s) ---
        const instructionData = Buffer.concat([
            bufferFromUInt64(type === 'buy' ? '16927863322537952870' : '12502976635542562355'), // Discriminators
            bufferFromUInt64(tokenAmountRaw.toString()), // Convert bigint to string
            bufferFromUInt64(solAmountLamports.toString()), // Convert bigint to string
        ]);

        // Keys based on inspecting transactions and original code
        // TEMPORARY FIX: Use specific key lists observed for BUY/SELL
        const buyKeys = [
            { pubkey: CNST.GLOBAL, isSigner: false, isWritable: false },
            { pubkey: CNST.FEE_RECIPIENT, isSigner: false, isWritable: true },
            { pubkey: pumpTokenMintAddress, isSigner: false, isWritable: false },
            { pubkey: BONDING_CURVE, isSigner: false, isWritable: true },
            { pubkey: ASSOCIATED_BONDING_CURVE, isSigner: false, isWritable: true },
            { pubkey: userAssociatedTokenAccount, isSigner: false, isWritable: true },
            { pubkey: payer, isSigner: true, isWritable: true },
            { pubkey: CNST.SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: CNST.RENT, isSigner: false, isWritable: false },
            { pubkey: CNST.PUMP_FUN_ACCOUNT, isSigner: false, isWritable: false },
            { pubkey: CNST.PUMP_FUN_PROGRAM, isSigner: false, isWritable: false },
        ];
        const sellKeys = [
             { pubkey: CNST.GLOBAL, isSigner: false, isWritable: false },
             { pubkey: CNST.FEE_RECIPIENT, isSigner: false, isWritable: true },
             { pubkey: pumpTokenMintAddress, isSigner: false, isWritable: false },
             { pubkey: BONDING_CURVE, isSigner: false, isWritable: true },
             { pubkey: ASSOCIATED_BONDING_CURVE, isSigner: false, isWritable: true },
             { pubkey: userAssociatedTokenAccount, isSigner: false, isWritable: true },
             { pubkey: payer, isSigner: true, isWritable: true },
             { pubkey: CNST.SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
             { pubkey: CNST.ASSOC_TOKEN_ACC_PROG, isSigner: false, isWritable: false }, // Note: ATA Prog ID for Sell
             { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
             { pubkey: CNST.PUMP_FUN_ACCOUNT, isSigner: false, isWritable: false },
             { pubkey: CNST.PUMP_FUN_PROGRAM, isSigner: false, isWritable: false },
        ];

        const swapInstruction: TransactionInstruction = {
            programId: CNST.PUMP_FUN_PROGRAM,
            keys: type === 'buy' ? buyKeys : sellKeys,
            data: instructionData,
        };

        // --- Fee Transfer Instruction ---
        let feeInstruction: TransactionInstruction | undefined = undefined;
        if (sendyFeeLamports > 0n) {
            feeInstruction = makeSendyFeeInstruction({
                from: payer,
                to: SENDY_FEE_ACCOUNT,
                lamports: Number(sendyFeeLamports),
            });
        }

        // --- Concatenate all instructions in correct order ---
        const allInstructions: TransactionInstruction[] = [
            ...preparatoryInstructions,
            ...(feeInstruction ? [feeInstruction] : []),
            swapInstruction,
        ];

        // Add WSOL unwrap instruction if needed
        await addWsolUnwrapInstructionIfNeeded({
            outputMint: transactionDetails.params.outputMint,
            userPublicKey: payer,
            instructions: allInstructions
        });

        // Add close token account instruction if selling all tokens
        if (transactionDetails.params.type === 'sell') {
            await addCloseTokenAccountInstructionIfSellAll({
                connection: dependencies.connection,
                inputMint: transactionDetails.params.inputMint,
                amount: transactionDetails.params.amount,
                userPublicKey: payer,
                instructions: allInstructions,
                isSellOperation: true
            });
        }

        return {
            success: true,
            instructions: allInstructions,
            addressLookupTables: [], // TODO: handle LUTs if needed
            sendyFeeLamports: Number(sendyFeeLamports),
        };
    }
} 