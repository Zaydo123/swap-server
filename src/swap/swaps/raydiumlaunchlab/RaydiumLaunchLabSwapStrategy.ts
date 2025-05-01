import {
  Connection,
  PublicKey,
  TransactionInstruction,
  Keypair,
  SystemProgram,
  LAMPORTS_PER_SOL,
  AccountInfo,
  VersionedTransaction,
  clusterApiUrl,
} from "@solana/web3.js";
import {
  SPL_MINT_LAYOUT,
} from "@raydium-io/raydium-sdk";
import {
  Raydium,
} from "@raydium-io/raydium-sdk-v2";
import { ISwapStrategy, GenerateInstructionsResult, SwapStrategyDependencies } from "../base/ISwapStrategy";
import { TransactionProps } from "../../swap";
import BN from "bn.js";
import { NATIVE_MINT } from "@solana/spl-token";
import Decimal from "decimal.js";
import { ensureUserTokenAccounts } from '../utils/ensureTokenAccounts';
import {
  TxVersion,
} from '@raydium-io/raydium-sdk-v2';
import { Curve, PlatformConfig, getPdaLaunchpadPoolId } from '@raydium-io/raydium-sdk-v2';
import { LAUNCHPAD_PROGRAM } from '../../constants';

// 3. Define Logger class
class Logger {
  constructor(private name: string) {}
  info(message: string, ...args: any[]) { console.log(`[${this.name}] INFO: ${message}`, ...args); }
  warn(message: string, ...args: any[]) { console.warn(`[${this.name}] WARN: ${message}`, ...args); }
  error(message: string, ...args: any[]) { console.error(`[${this.name}] ERROR: ${message}`, ...args); }
}


const logger = new Logger("RaydiumLaunchLabSwapStrategy");


export class RaydiumLaunchLabSwapStrategy
  implements ISwapStrategy
{
  private launchpadPoolInfo: any | null = null;
  private platformInfo: any | null = null;
  private readonly connection: Connection;
  private readonly wallet: Keypair;
  private raydiumSdk: Raydium | null = null;
  private forceTestMode: boolean = false;
  private versionedTransaction: VersionedTransaction | undefined = undefined;

  constructor(
    connection: Connection,
    wallet: Keypair,
    forceTestMode: boolean = false
  ) {
    this.connection = connection;
    this.wallet = wallet;
    this.forceTestMode = forceTestMode;
    logger.info(`Initialized Raydium LaunchLab Strategy${forceTestMode ? ' in TEST MODE' : ''}`);
  }

  // Initialize Raydium SDK
  private async initRaydiumSdk(): Promise<Raydium> {
    if (!this.raydiumSdk) {
      // Initialize SDK with appropriate connection and cluster
      this.raydiumSdk = await Raydium.load({
        connection: this.connection,
        owner: this.wallet,
        cluster: 'mainnet',
      });

      logger.info(`Raydium SDK initialized in MAINNET mode`);
    }
    return this.raydiumSdk;
  }
  
  // Calculate and return poolId from mint addresses
  private async getPoolId(mintAddress: PublicKey): Promise<PublicKey> {
    try {
      // Use NATIVE_MINT as the counterpart (assuming SOL is always the counter currency)
      const counterMint = NATIVE_MINT;
      
      // Derive pool ID using getPdaLaunchpadPoolId
      const pdaResult = getPdaLaunchpadPoolId(
        LAUNCHPAD_PROGRAM,
        mintAddress,
        counterMint
      );
      
      logger.info(`Derived pool ID for ${mintAddress.toBase58()}: ${pdaResult.publicKey.toBase58()}`);
      return pdaResult.publicKey;
    } catch (error) {
      logger.error(`Failed to get pool ID: ${error}`);
      throw new Error(`Failed to calculate pool ID: ${error}`);
    }
  }

  async canHandle(swapData: TransactionProps, dependencies: SwapStrategyDependencies): Promise<boolean> {
    try {
      // Check if the token address (mint) looks like a Raydium Launchpad token
      const mintAddressStr = swapData.params.mintAddress;
      
      // Skip tokens that clearly aren't Raydium Launchpad tokens
      // Common naming patterns for non-Launchpad tokens we should skip
      if (mintAddressStr.toLowerCase().includes('pump') || // Skip Pump.fun tokens 
          mintAddressStr.toLowerCase().includes('moon')) { // Skip Moonshot tokens
        logger.info(`Skipping non-Launchpad token: ${mintAddressStr}`);
        return false;
      }
      
      const mintAddress = new PublicKey(mintAddressStr);
      
      // Calculate pool ID from mint address
      const poolId = await this.getPoolId(mintAddress);
      
      // Initialize SDK if not already initialized
      const raydium = await this.initRaydiumSdk();

      // Fetch pool info - add timeout to prevent hanging
      logger.info(`Fetching Launchpad Pool info for ${poolId.toBase58()}`);
      
      try {
        // Create a timeout promise that rejects after 5 seconds
        const timeoutPromise = new Promise((_, reject) => {
          setTimeout(() => reject(new Error('Pool info fetch timed out')), 5000);
        });
        
        // Race the pool info fetch against the timeout
        this.launchpadPoolInfo = await Promise.race([
          raydium.launchpad.getRpcPoolInfo({ poolId }),
          timeoutPromise
        ]) as any;
        
        if (!this.launchpadPoolInfo) {
          logger.error(`Failed to fetch pool info for ${poolId.toBase58()}`);
          return false;
        }
        
        // Also fetch platform info
        const platformData = await this.connection.getAccountInfo(this.launchpadPoolInfo.platformId);
        if (!platformData) {
          logger.error(`Failed to fetch platform info for ${this.launchpadPoolInfo.platformId.toBase58()}`);
          return false;
        }
        
        this.platformInfo = PlatformConfig.decode(platformData.data);
        
        logger.info(
          `Successfully fetched Launchpad Pool info. Base Mint: ${this.launchpadPoolInfo.mintA.toBase58()}, Quote Mint: ${this.launchpadPoolInfo.mintB.toBase58()}`
        );
      } catch (error) {
        logger.error(`Error fetching Launchpad Pool info: ${error}`);
        return false;
      }
      
      // Check if the token mint matches what the pool offers
      const isBaseMint = mintAddress.equals(this.launchpadPoolInfo.mintA);
      const isQuoteMint = mintAddress.equals(this.launchpadPoolInfo.mintB);
      
      if (!isBaseMint && !isQuoteMint) {
        logger.warn(
          `Requested mint ${mintAddress.toBase58()} doesn\'t match either pool mint: Base: ${this.launchpadPoolInfo.mintA.toBase58()}, Quote: ${this.launchpadPoolInfo.mintB.toBase58()}`
        );
        return false;
      }

      // Check if this is a valid operation for the LaunchLab pool
      const isBuy = swapData.params.type === 'buy';
      const isSell = swapData.params.type === 'sell';
      
      // Check pool status - only active pools can be used (unless in test mode or on devnet)
      const poolStatus = this.launchpadPoolInfo.status;
      
      if (poolStatus !== 4) { 
        logger.warn(`Launchpad pool ${poolId.toBase58()} is not active (status: ${poolStatus}). Cannot handle swap.`);
        return false;
      }

      // Handle buy/sell operations
      if (isSell && isBaseMint) {
        logger.info(`Can handle selling base token ${mintAddress.toBase58()} for quote token`);
        return true;
      } else if (isBuy && isQuoteMint) {
        logger.info(`Can handle buying base token with quote token ${mintAddress.toBase58()}`);
        return true;
      } else if (isBuy && isBaseMint) {
        // This is a special case: User wants to buy a token by its mint (not the quote token)
        logger.info(`Handling request to buy token by direct mint reference: ${mintAddress.toBase58()}`);
        return true;
      } else {
        logger.warn(`Cannot handle ${isBuy ? 'buy' : 'sell'} operation for mint ${mintAddress.toBase58()}`);
        return false;
      }
    } catch (error) {
      logger.error(`Error in canHandle: ${error}`);
      return false;
    }
  }

  private extractInstructionsFromVersionedTransaction(versionedTx: VersionedTransaction): TransactionInstruction[] {
    try {
      logger.info("Processing VersionedTransaction to extract instructions");
      
      // For testing purposes in forceTestMode, we can just return a dummy instruction
      // that represents that the operation would succeed
      if (this.forceTestMode) {
        // Create a simple SystemProgram transfer instruction as a placeholder
        // This isn't a real swap instruction, but it validates our test flow
        return [
          SystemProgram.transfer({
            fromPubkey: this.wallet.publicKey,
            toPubkey: this.wallet.publicKey,
            lamports: 0 // zero lamport transfer as a no-op
          })
        ];
      }
      
      // In production, the SDK's versioned transaction would be used directly
      // rather than trying to extract instructions. The wrapper code in 
      // generateSwapTransaction() would handle this special case.
      logger.info("In production, the Raydium versioned transaction would be used directly");
      
      // Return an empty array - in production we would use the full VersionedTransaction
      return [];
    } catch (error) {
      logger.error("Failed to extract instructions from VersionedTransaction:", error);
      return [];
    }
  }

  async generateSwapInstructions(
    swapData: TransactionProps,
    dependencies: SwapStrategyDependencies
  ): Promise<GenerateInstructionsResult> {
    try {
      // Get mint address
      const mintAddress = new PublicKey(swapData.params.mintAddress);
      
      // Calculate pool ID
      let poolId: PublicKey;
      let getPdaLaunchpadPoolIdFn: any = undefined;
      try {
        // Dynamically require Raydium SDK v2 for compatibility
        const raydiumSdk = require('@raydium-io/raydium-sdk-v2');
        getPdaLaunchpadPoolIdFn = raydiumSdk.getPdaLaunchpadPoolId;
      } catch (e) {
        console.error('Error requiring Raydium SDK v2:', e);
        throw new Error('Could not determine Raydium Launchpad program ID. Aborting swap.');
      }
      const mintA = new PublicKey(mintAddress);
      const mintB = NATIVE_MINT;
      if (typeof getPdaLaunchpadPoolIdFn === 'function') {
        poolId = getPdaLaunchpadPoolIdFn(LAUNCHPAD_PROGRAM, mintA, mintB).publicKey;
      } else {
        // Manual fallback for pool PDA derivation
        poolId = PublicKey.findProgramAddressSync(
          [Buffer.from('launchpad_pool'), mintA.toBuffer(), mintB.toBuffer()],
          LAUNCHPAD_PROGRAM
        )[0];
      }
      
      logger.info(`Generating LaunchLab swap instructions for pool ${poolId.toBase58()}`);

      // Initialize SDK if not already initialized
      const raydium = await this.initRaydiumSdk();
      
      // Fetch pool info if not already fetched
      if (!this.launchpadPoolInfo) {
        logger.info("Pool info not fetched yet, fetching now...");
        
        // Create a timeout promise that rejects after 5 seconds
        const timeoutPromise = new Promise((_, reject) => {
          setTimeout(() => reject(new Error('Pool info fetch timed out')), 5000);
        });
        
        // Make multiple attempts with increasing timeouts
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            logger.info(`Fetching pool info, attempt ${attempt}/3`);
            // Race the pool info fetch against the timeout
            this.launchpadPoolInfo = await Promise.race([
              raydium.launchpad.getRpcPoolInfo({ poolId }),
              timeoutPromise
            ]) as any;
            
            if (this.launchpadPoolInfo) {
              break; // Exit the loop if successful
            }
          } catch (fetchError) {
            logger.warn(`Attempt ${attempt} failed: ${fetchError}`);
            if (attempt === 3) {
              throw new Error(`Failed to fetch pool info after 3 attempts: ${fetchError}`);
            }
            // Wait before next attempt (exponential backoff)
            await new Promise(resolve => setTimeout(resolve, attempt * 1000));
          }
        }
        
        if (!this.launchpadPoolInfo) {
          throw new Error(`Failed to fetch pool info for ${poolId.toBase58()}`);
        }
        
        // Handle platform info with timeout as well
        try {
          const platformFetchPromise = this.connection.getAccountInfo(this.launchpadPoolInfo.platformId);
          const platformTimeoutPromise = new Promise<null>((_, reject) => {
            setTimeout(() => reject(new Error('Platform info fetch timed out')), 5000);
          });
          
          const platformData = await Promise.race([platformFetchPromise, platformTimeoutPromise]) as AccountInfo<Buffer>;
          
          if (!platformData) {
            throw new Error(`Failed to fetch platform info for ${this.launchpadPoolInfo.platformId.toBase58()}`);
          }
          
          this.platformInfo = PlatformConfig.decode(platformData.data);
        } catch (platformError) {
          logger.error(`Error fetching platform info: ${platformError}`);
          throw new Error(`Failed to fetch platform info: ${platformError}`);
        }
      }

      const { type, amount, slippage } = swapData.params;
      const slippageBN = new BN(Math.floor(slippage * 100)); // Convert to basis points (e.g., 1% = 100)
      
      // Determine if we're buying or selling the base token
      const targetMint = mintAddress;
      const isBuy = type === 'buy';
      const isSell = type === 'sell';
      
      // Check if the mint matches with pool mints
      const isBaseMint = targetMint.equals(this.launchpadPoolInfo.mintA);
      // const isQuoteMint = targetMint.equals(this.launchpadPoolInfo.mintB);
      
      // Special case handling: if user specified base mint with 'buy' operation,
      // we need to handle it as a buy operation but switch the mint reference
      const effectiveMint = (isBuy && isBaseMint) ? this.launchpadPoolInfo.mintB : targetMint;
      const effectiveIsBaseMint = effectiveMint.equals(this.launchpadPoolInfo.mintA);
      const effectiveIsQuoteMint = effectiveMint.equals(this.launchpadPoolInfo.mintB);
      
      // Ensure user token accounts exist for both base and quote mints (middleware)
      const userPublicKey = new PublicKey(swapData.params.userWalletAddress);
      await ensureUserTokenAccounts({
        connection: this.connection,
        userPublicKey,
        mints: [this.launchpadPoolInfo.mintA, this.launchpadPoolInfo.mintB],
        preparatoryInstructions: []
      });

      if ((!effectiveIsBaseMint && !effectiveIsQuoteMint) || 
          (isBuy && !effectiveIsQuoteMint) || 
          (isSell && !effectiveIsBaseMint)) {
        throw new Error(
          `Invalid operation: ${type} for mint ${mintAddress}. Check pool configuration.`
        );
      }

      if (isBuy && effectiveIsQuoteMint) {
        // Buying base token with quote token (SOL)
        // Convert amount to lamports for SOL
        const inAmount = new BN(Math.floor(amount * Math.pow(10, this.launchpadPoolInfo.mintDecimalsB)));
        
        // Calculate expected output amount using Curve calculation
        const curveResult = Curve.buyExactIn({
          poolInfo: this.launchpadPoolInfo,
          amountB: inAmount,
          protocolFeeRate: this.launchpadPoolInfo.configInfo?.tradeFeeRate || new BN(0),
          platformFeeRate: this.platformInfo.feeRate,
          curveType: this.launchpadPoolInfo.configInfo?.curveType || 0,
          shareFeeRate: new BN(0),
        });
        
        // Calculate minimum amount out with slippage
        const minOutAmount = new BN(
          new Decimal(curveResult.amountA.toString())
            .mul((10000 - slippageBN.toNumber()) / 10000)
            .toFixed(0)
        );
        
        logger.info(
          `Buying base token: Expected to receive ${curveResult.amountA.toString()} tokens, ` +
          `minimum with slippage: ${minOutAmount.toString()}`
        );
        
        // For debugging
        console.log({ amountB: inAmount.toString(), minAmountA: minOutAmount.toString() });
        
        // Get the actual mint for the SDK call
        const mintA = this.launchpadPoolInfo.mintA;
        
        // Use the SDK to create the buy transaction
        const sdkResponse = await raydium.launchpad.buyToken({
          programId: LAUNCHPAD_PROGRAM,
          mintA: mintA,
          feePayer: new PublicKey(swapData.params.userWalletAddress),
          configInfo: this.launchpadPoolInfo.configInfo,
          buyAmount: inAmount,
          computeBudgetConfig: {
            units: 400000,
            microLamports: swapData.params.priorityFee ? 
              Math.floor(swapData.params.priorityFee * LAMPORTS_PER_SOL / 400000) : 
              10000
          },
          txVersion: TxVersion.V0,
          slippage: slippageBN,
        });
        
        // For testing or debugging with the complete SDK response
        // If in production, you can return the entire transaction to be used directly
        if (this.forceTestMode) {
          // In test mode, we can just return an empty result
          // In production, you would return the transaction or more detailed info
          return {
            instructions: [],
            sendyFeeLamports: BigInt(0),
            poolAddress: poolId,
            cleanupInstructions: [],
          };
        }
        
        let instructions: TransactionInstruction[] = [];
        let versionedTransaction: VersionedTransaction | undefined;
        
        // Handle different SDK response formats
        if (sdkResponse.transaction) {
          // If transaction is returned directly
          if ('instructions' in sdkResponse.transaction) {
            instructions = (sdkResponse.transaction as any).instructions || [];
          } else if (sdkResponse.transaction instanceof VersionedTransaction) {
            // Store the versioned transaction
            versionedTransaction = sdkResponse.transaction as VersionedTransaction;
            logger.info("Received VersionedTransaction with V0 message format");
            
            // Try to extract instructions (optional)
            instructions = this.extractInstructionsFromVersionedTransaction(versionedTransaction);
          }
        } else if (sdkResponse.builder) {
          // If builder is returned, we can get instructions from the transaction builder
          const txBuilder = sdkResponse.builder;
          instructions = txBuilder.allInstructions || [];
        } else if (sdkResponse.execute) {
          // If execute function is returned, we can call it to get the transaction
          try {
            const transaction = await sdkResponse.execute();
            if (transaction && 'instructions' in transaction) {
              instructions = (transaction as any).instructions || [];
            }
          } catch (executeError) {
            logger.error(`Error executing transaction: ${executeError}`);
            throw executeError;
          }
        }
        
        if (instructions.length === 0 && !versionedTransaction) {
          logger.warn("No instructions were extracted from the SDK response");
          
          // If we couldn't extract instructions but have the transaction message,
          // we can include it directly as a serialized transaction
          if (sdkResponse.transaction) {
            logger.info("Using the full transaction from SDK response");
            // In this case we might need to return the whole transaction instead of just instructions
            // This depends on how your system handles transactions
          }
        }
        
        // Prepare result object with standard interface properties
        const result = {
          instructions,
          sendyFeeLamports: BigInt(0), // Calculate fee if needed
          poolAddress: poolId,
          cleanupInstructions: [], 
        };
        
        // Attach the versioned transaction as a non-standard property
        // The higher-level code can use this if present
        if (versionedTransaction) {
          (result as any)._raydiumVersionedTx = versionedTransaction;
        }
        
        return result;
        
      } else if (isSell && effectiveIsBaseMint) {
        // Selling base token for quote token (SOL)
        const inAmount = new BN(Math.floor(amount * Math.pow(10, this.launchpadPoolInfo.mintDecimalsA)));
        
        // Calculate expected output amount using Curve calculation
        const curveResult = Curve.sellExactIn({
          poolInfo: this.launchpadPoolInfo,
          amountA: inAmount,
          protocolFeeRate: this.launchpadPoolInfo.configInfo?.tradeFeeRate || new BN(0),
          platformFeeRate: this.platformInfo.feeRate,
          curveType: this.launchpadPoolInfo.configInfo?.curveType || 0,
          shareFeeRate: new BN(0),
        });
        
        // Calculate minimum amount out with slippage
        const minOutAmount = new BN(
          new Decimal(curveResult.amountB.toString())
            .mul((10000 - slippageBN.toNumber()) / 10000)
            .toFixed(0)
        );
        
        logger.info(
          `Selling base token: Expected to receive ${curveResult.amountB.toString()} SOL, ` +
          `minimum with slippage: ${minOutAmount.toString()}`
        );
        
        // Use the SDK to create the sell transaction
        const sdkResponse = await raydium.launchpad.sellToken({
          programId: LAUNCHPAD_PROGRAM,
          mintA: this.launchpadPoolInfo.mintA,
          feePayer: new PublicKey(swapData.params.userWalletAddress),
          configInfo: this.launchpadPoolInfo.configInfo,
          sellAmount: inAmount,
          computeBudgetConfig: {
            units: 400000,
            microLamports: swapData.params.priorityFee ? 
              Math.floor(swapData.params.priorityFee * LAMPORTS_PER_SOL / 400000) : 
              10000
          },
          txVersion: TxVersion.V0,
          slippage: slippageBN,
        });
        
        // For testing purposes in forceTestMode
        if (this.forceTestMode) {
          return {
            instructions: [],
            sendyFeeLamports: BigInt(0),
            poolAddress: poolId,
            cleanupInstructions: [],
          };
        }
        
        let instructions: TransactionInstruction[] = [];
        let versionedTransaction: VersionedTransaction | undefined;
        
        // Handle different SDK response formats
        if (sdkResponse.transaction) {
          // If transaction is returned directly
          if ('instructions' in sdkResponse.transaction) {
            instructions = (sdkResponse.transaction as any).instructions || [];
          } else if (sdkResponse.transaction instanceof VersionedTransaction) {
            // Store the versioned transaction
            versionedTransaction = sdkResponse.transaction as VersionedTransaction;
            logger.info("Received VersionedTransaction with V0 message format");
            
            // Try to extract instructions (optional)
            instructions = this.extractInstructionsFromVersionedTransaction(versionedTransaction);
          }
        } else if (sdkResponse.builder) {
          // If builder is returned, we can get instructions from the transaction builder
          const txBuilder = sdkResponse.builder;
          instructions = txBuilder.allInstructions || [];
        } else if (sdkResponse.execute) {
          // If execute function is returned, we can call it to get the transaction
          try {
            const transaction = await sdkResponse.execute();
            if (transaction && 'instructions' in transaction) {
              instructions = (transaction as any).instructions || [];
            }
          } catch (executeError) {
            logger.error(`Error executing transaction: ${executeError}`);
            throw executeError;
          }
        }
        
        if (instructions.length === 0 && !versionedTransaction) {
          logger.warn("No instructions were extracted from the SDK response");
          
          // If we couldn't extract instructions but have the transaction message,
          // we can include it directly as a serialized transaction
          if (sdkResponse.transaction) {
            logger.info("Using the full transaction from SDK response");
            // In this case we might need to return the whole transaction instead of just instructions
            // This depends on how your system handles transactions
          }
        }
        
        // Prepare standard result object
        const result = {
          instructions,
          sendyFeeLamports: BigInt(0), // Calculate fee if needed
          poolAddress: poolId,
          cleanupInstructions: [],
        };
        
        // Attach the versioned transaction as a non-standard property for the higher-level code
        if (versionedTransaction) {
          (result as any)._raydiumVersionedTx = versionedTransaction;
        }
        
        return result;
      } else {
        throw new Error(`Unsupported operation: ${type} for mint ${mintAddress}`);
      }
    } catch (error) {
      logger.error(`Error generating swap instructions: ${error}`);
      throw new Error(`Failed to generate swap instructions: ${error}`);
    }
  }

  // Implement estimation methods for UI display
  async estimateAmountOut(
    tokenInMint: PublicKey,
    amountIn: number | string
  ): Promise<{ amountOut: number; impact: number }> {
    try {
      // Calculate pool ID from token mint
      const poolId = await this.getPoolId(tokenInMint);
      
      // Initialize SDK if not already initialized
      const raydium = await this.initRaydiumSdk();
      
      // Fetch pool info if not already fetched
      if (!this.launchpadPoolInfo || !this.platformInfo) {
        this.launchpadPoolInfo = await raydium.launchpad.getRpcPoolInfo({ poolId });
        
        const platformData = await this.connection.getAccountInfo(this.launchpadPoolInfo.platformId);
        if (platformData) {
          this.platformInfo = PlatformConfig.decode(platformData.data);
        } else {
          throw new Error(`Failed to fetch platform info for ${this.launchpadPoolInfo.platformId.toBase58()}`);
        }
      }
      
      const isBaseMint = tokenInMint.equals(this.launchpadPoolInfo.mintA);
      const isQuoteMint = tokenInMint.equals(this.launchpadPoolInfo.mintB);
      
      if (!isBaseMint && !isQuoteMint) {
        throw new Error(`Invalid input mint ${tokenInMint.toBase58()}`);
      }
      
      // No share fee for estimation
      const shareFeeRate = new BN(0);
      
      // Default protocol fee rate and curve type
      const protocolFeeRate = new BN(0); 
      const curveType = 0;
      
      // Convert amount to BN
      const amountInNum = typeof amountIn === 'string' ? parseFloat(amountIn) : amountIn;
      const decimals = isBaseMint 
        ? this.launchpadPoolInfo.mintDecimalsA 
        : this.launchpadPoolInfo.mintDecimalsB;
      
      const amountInBN = new BN(Math.floor(amountInNum * Math.pow(10, decimals)));
      
      let result;
      if (isBaseMint) {
        // Selling base token to get quote token
        result = Curve.sellExactIn({
          poolInfo: this.launchpadPoolInfo,
          amountA: amountInBN,
          protocolFeeRate,
          platformFeeRate: this.platformInfo.feeRate,
          curveType,
          shareFeeRate,
        });
        
        const amountOut = Number(result.amountB.toString()) / Math.pow(10, this.launchpadPoolInfo.mintDecimalsB);
        return { amountOut, impact: 0 };
      } else {
        // Buying base token with quote token
        result = Curve.buyExactIn({
          poolInfo: this.launchpadPoolInfo,
          amountB: amountInBN,
          protocolFeeRate,
          platformFeeRate: this.platformInfo.feeRate,
          curveType,
          shareFeeRate,
        });
        
        const amountOut = Number(result.amountA.toString()) / Math.pow(10, this.launchpadPoolInfo.mintDecimalsA);
        return { amountOut, impact: 0 };
      }
    } catch (error) {
      logger.error(`Error estimating amount out: ${error}`);
      throw new Error(`Failed to estimate amount out: ${error}`);
    }
  }

  async estimateAmountIn(
    tokenOutMint: PublicKey,
    amountOut: number | string
  ): Promise<{ amountIn: number; impact: number }> {
    try {
      // Calculate pool ID from token mint
      const poolId = await this.getPoolId(tokenOutMint);
      
      // Initialize SDK if not already initialized
      const raydium = await this.initRaydiumSdk();
      
      // Fetch pool info if not already fetched
      if (!this.launchpadPoolInfo || !this.platformInfo) {
        this.launchpadPoolInfo = await raydium.launchpad.getRpcPoolInfo({ poolId });
        
        const platformData = await this.connection.getAccountInfo(this.launchpadPoolInfo.platformId);
        if (platformData) {
          this.platformInfo = PlatformConfig.decode(platformData.data);
        } else {
          throw new Error(`Failed to fetch platform info for ${this.launchpadPoolInfo.platformId.toBase58()}`);
        }
      }
      
      const isBaseMint = tokenOutMint.equals(this.launchpadPoolInfo.mintA);
      const isQuoteMint = tokenOutMint.equals(this.launchpadPoolInfo.mintB);
      
      if (!isBaseMint && !isQuoteMint) {
        throw new Error(`Invalid output mint ${tokenOutMint.toBase58()}`);
      }
      
      // No share fee for estimation
      const shareFeeRate = new BN(0);
      
      // Default protocol fee rate and curve type
      const protocolFeeRate = new BN(0);
      const curveType = 0;
      
      // Convert amount to BN
      const amountOutNum = typeof amountOut === 'string' ? parseFloat(amountOut) : amountOut;
      const decimals = isBaseMint 
        ? this.launchpadPoolInfo.mintDecimalsA 
        : this.launchpadPoolInfo.mintDecimalsB;
      
      const amountOutBN = new BN(Math.floor(amountOutNum * Math.pow(10, decimals)));
      
      let result;
      if (isBaseMint) {
        // Buy exact out: how much quote token to give to get exact base token amount
        result = Curve.buyExactOut({
          poolInfo: this.launchpadPoolInfo,
          amountA: amountOutBN,
          protocolFeeRate,
          platformFeeRate: this.platformInfo.feeRate,
          curveType,
          shareFeeRate,
        });
        
        const amountIn = Number(result.amountB.toString()) / Math.pow(10, this.launchpadPoolInfo.mintDecimalsB);
        return { amountIn, impact: 0 };
      } else {
        // Sell exact out: how much base token to give to get exact quote token amount
        result = Curve.sellExactOut({
          poolInfo: this.launchpadPoolInfo,
          amountB: amountOutBN,
          protocolFeeRate,
          platformFeeRate: this.platformInfo.feeRate,
          curveType,
          shareFeeRate,
        });
        
        const amountIn = Number(result.amountA.toString()) / Math.pow(10, this.launchpadPoolInfo.mintDecimalsA);
        return { amountIn, impact: 0 };
      }
    } catch (error) {
      logger.error(`Error estimating amount in: ${error}`);
      throw new Error(`Failed to estimate amount in: ${error}`);
    }
  }

  private async getTokenDecimals(mint: PublicKey): Promise<number> {
    const mintInfo = await this.connection.getAccountInfo(mint);
    if (!mintInfo) throw new Error(`Failed to fetch mint info for ${mint.toBase58()}`);
    const decoded = SPL_MINT_LAYOUT.decode(mintInfo.data);
    return decoded.decimals;
  }
}
