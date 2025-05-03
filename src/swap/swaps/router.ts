import { Connection, PublicKey, Keypair } from '@solana/web3.js';
import { TransactionProps } from '../swap';
import { ISwapStrategy, SwapStrategyDependencies, GenerateInstructionsResult } from './base/ISwapStrategy';
import { RaydiumSwapStrategy } from './raydium/RaydiumSwapStrategy';
import { MoonshotSwapStrategy } from './moonshot/MoonshotSwapStrategy';
import { PumpFunBondingCurveSwapStrategy } from './pumpfun/PumpFunBondingCurveSwapStrategy';
import { PumpSwapStrategy } from './pumpswap/PumpSwapStrategy';
import { RaydiumLaunchLabSwapStrategy } from './raydiumlaunchlab/RaydiumLaunchLabSwapStrategy';

// --- Define Strategy Classes/Factories --- 
// Store the classes themselves, not instances
const strategyClasses = [
    MoonshotSwapStrategy,
    PumpSwapStrategy,
    RaydiumLaunchLabSwapStrategy, 
    PumpFunBondingCurveSwapStrategy, 
    RaydiumSwapStrategy, 
];

// Cache for pump.fun data to avoid redundant fetches within a single call
const pumpDataCache = new Map<string, any>();
const pumpSwapCheckCache = new Map<string, { isBonded: boolean, data?: any }>();

// Helper function to fetch pump.fun data with caching
async function fetchPumpDataWithCache(mintAddress: string): Promise<any | null> {
    if (pumpDataCache.has(mintAddress)) {
        return pumpDataCache.get(mintAddress);
    }
    try {
        const dataURL = `https://frontend-api-v3.pump.fun/coins/${mintAddress}`;
        const response = await fetch(dataURL);
        if (!response.ok) {
             console.warn(`Failed to fetch pump.fun data for ${mintAddress}: ${response.status}`);
             pumpDataCache.set(mintAddress, null); // Cache failure
            return null;
        }
        const data = await response.json();
        pumpDataCache.set(mintAddress, data);
        return data;
    } catch (error) {
        console.error(`Error fetching pump.fun data for ${mintAddress}:`, error);
        pumpDataCache.set(mintAddress, null); // Cache error
        return null;
    }
}

// Helper function to check if a token is bonded to PumpSwap with caching
async function checkIsPumpswapBondedWithCache(mintAddress: string): Promise<{ isBonded: boolean, data?: any }> {
     if (pumpSwapCheckCache.has(mintAddress)) {
        return pumpSwapCheckCache.get(mintAddress)!;
    }
     try {
        const pumpswapCheckURL = `https://swap-api.pump.fun/v1/pools/pump-pool?base=${mintAddress}`;
        const pumpswapResponse = await fetch(pumpswapCheckURL);
        let result: { isBonded: boolean, data?: any };
        if (pumpswapResponse.ok) {
             const data = await pumpswapResponse.json();
            result = { isBonded: true, data: data };
        } else if (pumpswapResponse.status === 404) {
            result = { isBonded: false };
        } else {
            console.warn(`Error checking pumpswap status for ${mintAddress}: ${pumpswapResponse.status}`);
            result = { isBonded: false }; // Treat API errors as not bonded for safety
        }
        pumpSwapCheckCache.set(mintAddress, result);
        return result;
     } catch (error) {
        console.error(`Error checking pumpswap status for ${mintAddress}:`, error);
        const result = { isBonded: false }; // Treat fetch errors as not bonded
        pumpSwapCheckCache.set(mintAddress, result);
        return result;
     }
}

export async function getSwapStrategy(
    transactionDetails: TransactionProps,
    dependencies: SwapStrategyDependencies 
): Promise<ISwapStrategy> {
    const mintAddress = transactionDetails.params.mintAddress;
    const pairAddress = transactionDetails.params.pairAddress;
    
    // Clear caches
    pumpDataCache.clear();
    pumpSwapCheckCache.clear();

    console.log(`Routing swap for mint: ${mintAddress} on pair/pool: ${pairAddress}`);

    // 1. Create temporary instances for canHandle checks
    const tempStrategies = strategyClasses.map(StrategyClass => {
        try {
             const placeholderPubKey = new PublicKey('11111111111111111111111111111111'); 
            if (StrategyClass === RaydiumLaunchLabSwapStrategy) {
                 // Constructor: connection, wallet, poolId
                 return new StrategyClass(dependencies.connection, dependencies.wallet);
             } else if (StrategyClass === RaydiumSwapStrategy || StrategyClass === PumpFunBondingCurveSwapStrategy || StrategyClass === MoonshotSwapStrategy || StrategyClass === PumpSwapStrategy) {
                 return new StrategyClass();
             } else{
                throw new Error(`Unhandled strategy type during temp instantiation: ${StrategyClass.name}`);
             }
        } catch (e) {
            console.warn(`Failed to create temporary instance for ${StrategyClass.name}:`, e);
            return null; 
        }
    }).filter(s => s !== null) as ISwapStrategy[];

    // 2. Run canHandle checks in parallel
    const checkPromises = tempStrategies.map(strategy => 
        strategy.canHandle(transactionDetails, dependencies)
            .then(canHandle => ({ strategyClass: strategy.constructor as new (...args: any[]) => ISwapStrategy, canHandle })) 
            .catch(error => ({ strategyClass: strategy.constructor as new (...args: any[]) => ISwapStrategy, error }))
    );

    console.log("Waiting for parallel canHandle checks...");
    const results = await Promise.all(checkPromises);
    console.log("Parallel checks complete.");

    // 3. Find the first strategy CLASS that can handle the swap
    for (const result of results) {
        if ('canHandle' in result && result.canHandle === true) {
            const SelectedStrategyClass = result.strategyClass;
            console.log(`Selected strategy class: ${SelectedStrategyClass.name}`);

            // 4. Instantiate the *selected* strategy with proper arguments
            try {
                 if (SelectedStrategyClass === RaydiumLaunchLabSwapStrategy) {
                      return new SelectedStrategyClass(dependencies.connection, dependencies.wallet, new PublicKey(pairAddress));
                 } else if (SelectedStrategyClass === RaydiumSwapStrategy) {
                      return new SelectedStrategyClass(dependencies.connection, dependencies.wallet);
                 } else if (SelectedStrategyClass === PumpFunBondingCurveSwapStrategy) {
                      return new SelectedStrategyClass(dependencies.connection, dependencies.wallet);
                 } else if (SelectedStrategyClass === MoonshotSwapStrategy || SelectedStrategyClass === PumpSwapStrategy) {
                     return new SelectedStrategyClass();
                 } else {
                     // Should not happen if all strategies are covered
                      throw new Error(`Unhandled strategy type during final instantiation: ${SelectedStrategyClass.name}`);
                 }
            } catch (instantiationError) {
                 // Handle error with type check
                 const errorMessage = instantiationError instanceof Error ? instantiationError.message : String(instantiationError);
                 console.error(`Failed to instantiate selected strategy ${SelectedStrategyClass.name}:`, errorMessage);
                 throw new Error(`Failed to instantiate strategy ${SelectedStrategyClass.name}: ${errorMessage}`);
            }
        } else if ('error' in result) {
            console.warn(`Strategy ${result.strategyClass.name} check failed:`, result.error);
        }
    }

    // If no strategy returned true
    console.error(`Could not find any swap strategy for mint: ${mintAddress}. All canHandle checks returned false or failed.`);
    throw new Error(`Unsupported token or swap type for mint: ${mintAddress}`);
} 