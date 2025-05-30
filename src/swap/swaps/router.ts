import { Connection, PublicKey, Keypair } from '@solana/web3.js';
import { TransactionProps } from './base/ISwapStrategy';
import { ISwapStrategy, SwapStrategyDependencies } from './base/ISwapStrategy';
import { RaydiumSwapStrategy } from './raydium/RaydiumSwapStrategy';
import { MoonshotSwapStrategy } from './moonshot/MoonshotSwapStrategy';
import { PumpFunBondingCurveSwapStrategy } from './pumpfun/PumpFunBondingCurveSwapStrategy';
import { PumpSwapStrategy } from './pumpswap/PumpSwapStrategy';
import { RaydiumLaunchLabSwapStrategy } from './raydiumlaunchlab/RaydiumLaunchLabSwapStrategy';
import { getCache, setCache, getCacheTTL } from '../../utils/redisCache';

// --- Define Strategy Classes/Factories --- 
// Store the classes themselves, not instances
const strategyClasses = [
    MoonshotSwapStrategy,
    PumpSwapStrategy,
    RaydiumLaunchLabSwapStrategy, 
    PumpFunBondingCurveSwapStrategy, 
    RaydiumSwapStrategy, 
];

export async function getSwapStrategy(
    transactionDetails: TransactionProps,
    dependencies: SwapStrategyDependencies 
): Promise<ISwapStrategy> {
    const { inputMint, outputMint, type } = transactionDetails.params;
    const tokenMint = type === 'buy' ? outputMint : inputMint;

    // Pretty print the swap request
    console.log('\n================ Swap Request ================');
    console.log(JSON.stringify(transactionDetails, null, 2));
    console.log('==============================================\n');

    // Debug log helper (no-op by default)
    function debugLog(...args: any[]) {
      // console.log(...args); // Uncomment to enable debug logs
    }

    // --- Redis cache key ---
    const cacheKey = `swap_strategy:${tokenMint}:${type}`;
    const cached = await getCache(cacheKey);
    if (cached && cached.strategyName) {
      // Find the strategy class by name
      const StrategyClass = strategyClasses.find(cls => cls.name === cached.strategyName);
      if (StrategyClass) {
        debugLog(`[CACHE] Using cached strategy: ${cached.strategyName} for ${tokenMint} (${type})`);
        return new StrategyClass(dependencies.connection);
      }
    }

    // 1. Create temporary instances for canHandle checks
    const tempStrategies = strategyClasses.map(StrategyClass => {
        try {
            // All strategies now require (connection, userPublicKey)
            return new StrategyClass(dependencies.connection);
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

    // debugLog("Waiting for parallel canHandle checks...");
    const results = await Promise.all(checkPromises);
    // debugLog("Parallel checks complete.");

    // Print a table of strategy eligibility
    const tableRows = results.map(result => {
        const name = result.strategyClass?.name || 'Unknown';
        const canHandle = 'canHandle' in result ? result.canHandle : false;
        return { Strategy: name, CanHandle: canHandle ? '✅' : '❌' };
    });
    console.log('\n=== Swap Strategy Eligibility Table ===');
    console.table(tableRows);
    console.log('======================================\n');

    // 3. Find the first strategy CLASS that can handle the swap
    for (const result of results) {
        if ('canHandle' in result && result.canHandle === true) {
            const SelectedStrategyClass = result.strategyClass;
            debugLog(`[CACHE] Caching strategy: ${SelectedStrategyClass.name} for ${tokenMint} (${type})`);
            // Set cache for this token/type/strategy
            await setCache(cacheKey, { strategyName: SelectedStrategyClass.name }, getCacheTTL(SelectedStrategyClass.name));
            // 4. Instantiate the *selected* strategy with proper arguments
            try {
                // All strategies now require (connection, userPublicKey)
                return new SelectedStrategyClass(dependencies.connection);
            } catch (instantiationError) {
                // Handle error with type check
                const errorMessage = instantiationError instanceof Error ? instantiationError.message : String(instantiationError);
                console.error(`Failed to instantiate selected strategy ${SelectedStrategyClass.name}: ${errorMessage}`);
                throw new Error(`Failed to instantiate strategy ${SelectedStrategyClass.name}: ${errorMessage}`);
            }
        } else if ('error' in result) {
            console.warn(`Strategy ${result.strategyClass.name} check failed:`, result.error);
        }
    }

    // If no strategy returned true
    console.error(`Could not find any swap strategy for token: ${tokenMint}. All canHandle checks returned false or failed.`);
    throw new Error(`Unsupported token or swap type for token: ${tokenMint}`);
} 