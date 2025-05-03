import { PublicKey, TransactionInstruction, SystemProgram } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddress, NATIVE_MINT } from '@solana/spl-token';
import { LAMPORTS_PER_SOL } from '@solana/web3.js';
import { TransactionProps } from '../../swap'; // Adjust path
import { ISwapStrategy, GenerateInstructionsResult, SwapStrategyDependencies } from '../base/ISwapStrategy';
import * as CNST from '../../constants'; // Adjust path
import { Buffer } from 'buffer';
import { ensureUserTokenAccounts } from '../utils/ensureTokenAccounts';

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
        const mintAddress = transactionDetails.params.mintAddress;
        // This strategy only handles pump tokens
        // EndsWith check removed as router might handle non-pump tokens first

        try {
            console.log("Checking PumpFunBondingCurveStrategy eligibility for:", mintAddress);

            // Fetch necessary data using helper (assuming router pre-caches)
            // Use helper functions defined in router.ts context or pass cache/fetchers via dependencies
            // For now, directly fetch here, but caching in router is better
            const pumpswapCheckURL = `https://swap-api.pump.fun/v1/pools/pump-pool?base=${mintAddress}`;
            const pumpswapResponse = await fetch(pumpswapCheckURL);

            // 1. Check if bonded to pumpswap (if so, this strategy is NOT applicable)
            if (pumpswapResponse.ok) {
                console.log("Pump token is bonded to pumpswap, PumpFunBondingCurveStrategy cannot handle.");
                return false; // Handled by PumpSwapStrategy
            } else if (pumpswapResponse.status !== 404) {
                console.warn('Error checking pumpswap status for eligibility:', pumpswapResponse.status, await pumpswapResponse.text());
                // Treat API errors as potentially handleable by this strategy if pump swap fails, but log warning
            }

            // 2. Fetch pump.fun coin data
            const dataURL = `https://frontend-api-v3.pump.fun/coins/${mintAddress}`;
            const response = await fetch(dataURL);
            if (!response.ok) {
                 console.error(`Failed to fetch pump.fun coin data for eligibility check (${response.status})`);
                 // If we can't get data, we can't confirm it's a bonding curve pump token
                 return false;
            }
            
            let data: any;
            try {
                data = await response.json();
            } catch (parseError) {
                console.error(`Error parsing JSON from pump.fun API for ${mintAddress}:`, parseError);
                // If the response isn't valid JSON, it's not a valid pump.fun token for this strategy
                return false;
            }

             // Basic validation of essential bonding curve data
            if (!data.bonding_curve || !data.associated_bonding_curve || !data.mint || data.mint !== mintAddress) {
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


    async generateSwapInstructions(
        transactionDetails: TransactionProps,
        dependencies: SwapStrategyDependencies
    ): Promise<GenerateInstructionsResult> {
        console.log('--- Generating Pump.fun Bonding Curve Swap Instructions ---');
        const { connection } = dependencies;
        const { type, amount, amountIsInSol, slippage, userWalletAddress, mintAddress } = transactionDetails.params;
        const payer = new PublicKey(userWalletAddress);
        const tokenAddress = new PublicKey(mintAddress);

        // Ensure the user has ATAs for input and output mints
        const preparatoryInstructions: TransactionInstruction[] = [];
        const mintsToEnsure = Array.from(new Set([tokenAddress, NATIVE_MINT].map((m) => m.toString()))).map((s) => new PublicKey(s));
        await ensureUserTokenAccounts({
            connection,
            userPublicKey: payer,
            mints: mintsToEnsure,
            preparatoryInstructions
        });

        // Fetch pump.fun coin data
        const dataURL = `https://frontend-api-v3.pump.fun/coins/${tokenAddress.toString()}`;
        let data: any; // Use 'any' for now, or create a partial type based on GetMetadataResponse
        try {
            const response = await fetch(dataURL);
            if (!response.ok) {
                throw new Error(`Failed to fetch pump.fun coin data: ${response.statusText}`);
            }
            data = await response.json();
        } catch (error) {
             console.error("Error fetching pump.fun data for instruction generation:", error);
             throw new Error(`Could not fetch data for pump.fun token ${tokenAddress.toString()}`);
        }

        // --- Validation (Updated) --- 
        if (!data) {
            throw new Error('Fetched pump.fun data is null or undefined');
        }
        if (!data.bonding_curve || !data.associated_bonding_curve) {
            throw new Error('Invalid bonding curve addresses in pump.fun data');
        }
        // Check reserves (removed decimals check)
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
             console.log(`Fetched decimals for ${tokenAddress.toString()}: ${decimals}`);
        } catch(mintError) {
             console.error(`Error fetching decimals for mint ${tokenAddress.toString()}:`, mintError);
              throw new Error(`Failed to fetch decimals for token ${tokenAddress.toString()}: ${mintError instanceof Error ? mintError.message : String(mintError)}`);
        }
        // --- End Fetch Decimals --- 

        const BONDING_CURVE = new PublicKey(data.bonding_curve);
        const ASSOCIATED_BONDING_CURVE = new PublicKey(data.associated_bonding_curve);
        // Use decimals fetched from blockchain
        const tokenDecimalMultiplier = 10 ** decimals;

        // Get user's ATA - Pump requires allowOwnerOffCurve = true
        const userAssociatedTokenAccount = await getAssociatedTokenAddress(
            tokenAddress,
            payer,
            true // allowOwnerOffCurve = true for pump bonding curve
        );

        // Convert validated pump.fun data to BigInt safely
        const virtualSolReserves = BigInt(String(data.virtual_sol_reserves)); 
        const virtualTokenReserves = BigInt(String(data.virtual_token_reserves));
        const lampsPerSol = BigInt(LAMPORTS_PER_SOL);

        // Calculate token amount and SOL amount (logic from original swap.ts, adapted for bigint)
        let tokenAmountRaw: bigint;
        let solAmountLamports: bigint;
        let sendyFeeLamports: bigint = 0n;

        if (type === 'buy') {
            if (amountIsInSol) {
                // Calculate SOL input with slippage (max SOL willing to spend)
                const baseSolInput = BigInt(Math.floor(amount * LAMPORTS_PER_SOL)); // Base SOL amount in lamports
                solAmountLamports = baseSolInput + (baseSolInput * BigInt(Math.floor(slippage * 100))) / 10000n; // Add slippage %
                
                // Calculate minimum token amount out based on BASE SOL input (like in pumpswap.ts)
                if (virtualSolReserves === 0n) throw new Error("Pump virtual SOL reserves are zero.");
                // Use baseSolInput here for calculation
                tokenAmountRaw = (virtualTokenReserves * baseSolInput) / (virtualSolReserves + baseSolInput);
                
                sendyFeeLamports = solAmountLamports / 100n; // 1% fee on max SOL input
                console.log('Pump Buy (SOL input): ', { maxSolIn: solAmountLamports, minTokenOut: tokenAmountRaw, fee: sendyFeeLamports });
            } else {
                // Input is token amount (desired output)
                 tokenAmountRaw = BigInt(Math.floor(amount * tokenDecimalMultiplier)); // Uses fetched decimals
                // Calculate SOL required for the desired tokens
                // sol_in = (virtual_sol_reserves * token_out) / (virtual_token_reserves - token_out)
                 if (virtualTokenReserves <= tokenAmountRaw) throw new Error("Desired token amount exceeds pump reserves.");
                const baseSolRequired = (virtualSolReserves * tokenAmountRaw) / (virtualTokenReserves - tokenAmountRaw) + 1n; // Add 1 for rounding up
                // Add slippage to calculate max SOL willing to spend
                 solAmountLamports = baseSolRequired + (baseSolRequired * BigInt(Math.floor(slippage * 100))) / 10000n;
                sendyFeeLamports = solAmountLamports / 100n; // 1% fee on max SOL input
                 console.log('Pump Buy (Token input): ', { minTokenOut: tokenAmountRaw, maxSolIn: solAmountLamports, fee: sendyFeeLamports });
            }
        } else { // Sell
            // Input is token amount
            tokenAmountRaw = BigInt(Math.floor(amount * tokenDecimalMultiplier)); // Uses fetched decimals
             console.log('Pump Sell token amount (raw units): ', tokenAmountRaw);
            // Calculate minimum SOL output with slippage
            // sol_out = (virtual_sol_reserves * token_in) / (virtual_token_reserves + token_in)
            if (virtualTokenReserves === 0n && tokenAmountRaw === 0n) {
                // Avoid division by zero if both reserves and input are zero (though unlikely)
                solAmountLamports = 0n;
            } else if (virtualTokenReserves + tokenAmountRaw === 0n) {
                throw new Error("Denominator is zero in pump sell calculation.");
            } else {
                const expectedSolOutput = (virtualSolReserves * tokenAmountRaw) / (virtualTokenReserves + tokenAmountRaw);
                solAmountLamports = expectedSolOutput - (expectedSolOutput * BigInt(Math.floor(slippage * 100))) / 10000n; // Subtract slippage %
            }
            sendyFeeLamports = solAmountLamports / 100n; // 1% fee on min SOL output
             console.log('Pump Sell (Token input): ', { tokenIn: tokenAmountRaw, minSolOut: solAmountLamports, fee: sendyFeeLamports });
        }

        // Ensure amounts are non-negative
        tokenAmountRaw = tokenAmountRaw < 0n ? 0n : tokenAmountRaw;
        solAmountLamports = solAmountLamports < 0n ? 0n : solAmountLamports;
        sendyFeeLamports = sendyFeeLamports < 0n ? 0n : sendyFeeLamports;

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
            { pubkey: tokenAddress, isSigner: false, isWritable: false },
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
             { pubkey: tokenAddress, isSigner: false, isWritable: false },
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

        const instruction: TransactionInstruction = {
            programId: CNST.PUMP_FUN_PROGRAM,
            keys: type === 'buy' ? buyKeys : sellKeys,
            data: instructionData,
        };

        return {
            instructions: [...preparatoryInstructions, instruction],
            sendyFeeLamports: sendyFeeLamports,
            poolAddress: BONDING_CURVE // The bonding curve is the primary address interacted with
        };
    }
} 