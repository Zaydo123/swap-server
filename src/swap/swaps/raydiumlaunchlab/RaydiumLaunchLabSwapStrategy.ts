import {
  Connection,
  PublicKey,
  TransactionInstruction,
  Keypair,
  LAMPORTS_PER_SOL,
  VersionedTransaction,
} from "@solana/web3.js";
import { 
  Raydium, 
  TxVersion, 
  LAUNCHPAD_PROGRAM,
  PlatformConfig,
  Curve,
  getPdaLaunchpadPoolId
} from '@raydium-io/raydium-sdk-v2';
import { ISwapStrategy, GenerateInstructionsResult, SwapStrategyDependencies } from "../base/ISwapStrategy";
import { TransactionProps } from "../../swap";
import BN from "bn.js";
import { NATIVE_MINT } from "@solana/spl-token";
import Decimal from "decimal.js";
import { ensureUserTokenAccounts } from '../utils/ensureTokenAccounts';
import { LaunchpadPool } from '@raydium-io/raydium-sdk-v2';

// If needed, can use the hardcoded value as fallback
// const LAUNCHPAD_PROGRAM_ID = new PublicKey("LanMkFSVSncjWqWAM8MUHenZzt9xTcT3DcAp949ZwbF");

export class RaydiumLaunchLabSwapStrategy implements ISwapStrategy {
  private launchpadPoolInfo: any | null = null;
  private readonly connection: Connection;
  private readonly wallet: Keypair;
  private raydiumSdk: Raydium | null = null;
  private versionedTransaction: VersionedTransaction | undefined = undefined;

  constructor(connection: Connection, wallet: Keypair) {
    this.connection = connection;
    this.wallet = wallet;
    console.info(`Initialized Raydium LaunchLab Strategy`);
  }

  private async initRaydiumSdk(): Promise<Raydium> {
    if (!this.raydiumSdk) {
      this.raydiumSdk = await Raydium.load({
        connection: this.connection,
        owner: this.wallet,
        cluster: 'mainnet',
        disableFeatureCheck: false,
      });
    }
    return this.raydiumSdk;
  }

  // Use SDK's getPdaLaunchpadPoolId method
  private getPoolId(mintAddress: PublicKey): PublicKey {
    return getPdaLaunchpadPoolId(LAUNCHPAD_PROGRAM, mintAddress, NATIVE_MINT).publicKey;
  }

  async canHandle(swapData: TransactionProps, dependencies: SwapStrategyDependencies): Promise<boolean> {
    try {
      const mintAddressStr = swapData.params.mintAddress;
      if (mintAddressStr.toLowerCase().endsWith('pump') || mintAddressStr.toLowerCase().endsWith('moon')) {
        return false;
      }
      // Check Raydium Launchpad API for bonding status
      const apiUrl = `https://launch-mint-v1.raydium.io/get/by/mints?ids=${mintAddressStr}`;
      try {
        const response = await fetch(apiUrl);
        if (!response.ok) return false;
        const data = await response.json();
        const row = data?.data?.rows?.[0];
        if (!row) return false;
        const finishingRate = Number(row.finishingRate);
        if (isNaN(finishingRate)) return false;
        if (finishingRate < 100) {
          console.info(`RaydiumLaunchLabSwapStrategy: finishingRate < 100, not bonded, can handle.`);
          return true;
        } else {
          console.info(`RaydiumLaunchLabSwapStrategy: finishingRate >= 100, bonded, will not handle.`);
          return false;
        }
      } catch (apiErr) {
        console.warn('RaydiumLaunchLabSwapStrategy: error checking bonding status:', apiErr);
        return false;
      }
    } catch (error) {
      console.error(`RaydiumLaunchLabSwapStrategy error: ${error}`);
      console.info(`RaydiumLaunchLabSwapStrategy WONT handle`);
      return false;
    }
  }

  private extractInstructionsFromVersionedTransaction(versionedTx: VersionedTransaction): TransactionInstruction[] {
    // In production, the SDK's versioned transaction would be used directly
    // rather than trying to extract instructions. The wrapper code in 
    // generateSwapTransaction() would handle this special case.
    return [];
  }

  async generateSwapInstructions(
    swapData: TransactionProps,
    dependencies: SwapStrategyDependencies
  ): Promise<GenerateInstructionsResult> {
    try {
      const raydium = await this.initRaydiumSdk();

      // Get mint address
      const mintAddress = new PublicKey(swapData.params.mintAddress);
      
      // Calculate pool ID
      const mintA = mintAddress;
      const mintB = NATIVE_MINT; // Always using SOL as the quote token
      const poolId = this.getPoolId(mintA);
      
      // Ensure the user has ATAs for input and output mints
      const preparatoryInstructions: TransactionInstruction[] = [];
      const mintsToEnsure = Array.from(new Set([mintA, mintB].map((m) => m.toString()))).map((s) => new PublicKey(s));
      await ensureUserTokenAccounts({
        connection: this.connection,
        userPublicKey: this.wallet.publicKey,
        mints: mintsToEnsure,
        preparatoryInstructions
      });

      console.info(`Generating LaunchLab swap instructions for pool ${poolId.toBase58()}`);

      // Fetch pool info using the SDK - proper way
      this.launchpadPoolInfo = await raydium.launchpad.getRpcPoolInfo({ poolId });
      
      if (!this.launchpadPoolInfo) {
        throw new Error(`Failed to fetch pool info for ${poolId.toBase58()}`);
      }
      
      // Fetch and decode platform info
      const platformData = await this.connection.getAccountInfo(this.launchpadPoolInfo.platformId);
      if (!platformData) {
        throw new Error(`Failed to fetch platform data for ${this.launchpadPoolInfo.platformId.toBase58()}`);
      }
      
      // Decode platform data using the SDK's PlatformConfig
      const platformInfo = PlatformConfig.decode(platformData.data);
      
      const { type, amount, slippage } = swapData.params;
      const slippageBN = new BN(Math.floor(slippage * 100)); // Convert to basis points (e.g., 1% = 100)
      const shareFeeRate = new BN(0); // No share fee in our case
      
      // Determine if we're buying or selling the base token
      const isBuy = type === 'buy';
      const isSell = type === 'sell';
      
      // Check if the mint matches with pool mints
      const isBaseMint = mintAddress.equals(this.launchpadPoolInfo.mintA);
      
      // Special case handling: if user specified base mint with 'buy' operation,
      // we need to handle it as a buy operation but switch the mint reference
      const effectiveMint = (isBuy && isBaseMint) ? this.launchpadPoolInfo.mintB : mintAddress;
      const effectiveIsBaseMint = effectiveMint.equals(this.launchpadPoolInfo.mintA);
      const effectiveIsQuoteMint = effectiveMint.equals(this.launchpadPoolInfo.mintB);
      
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
        
        // Calculate expected output using Curve calculations (for reference)
        const curveResult = Curve.buyExactIn({
          poolInfo: this.launchpadPoolInfo,
          amountB: inAmount,
          protocolFeeRate: this.launchpadPoolInfo.configInfo?.tradeFeeRate || new BN(0),
          platformFeeRate: platformInfo.feeRate,
          curveType: this.launchpadPoolInfo.configInfo?.curveType || 0,
          shareFeeRate,
        });
        
        // Calculate minimum amount out with slippage
        const minOutAmount = new BN(
          new Decimal(curveResult.amountA.toString())
            .mul((10000 - slippageBN.toNumber()) / 10000)
            .toFixed(0)
        );
        
        if (minOutAmount.lte(new BN(0))) {
          throw new Error("Swap amount too small: would receive 0 tokens. Try a larger amount.");
        }
        
        console.info(
          `Buying base token: Expected to receive ${curveResult.amountA.toString()} tokens, ` +
          `minimum with slippage: ${minOutAmount.toString()}`
        );
        
        // Use the SDK to create the buy transaction - following official example
        const sdkResponse = await raydium.launchpad.buyToken({
          programId: LAUNCHPAD_PROGRAM,
          mintA: this.launchpadPoolInfo.mintA,
          feePayer: new PublicKey(swapData.params.userWalletAddress),
          configInfo: this.launchpadPoolInfo.configInfo,
          buyAmount: inAmount,
          platformFeeRate: platformInfo.feeRate,
          computeBudgetConfig: {
            units: 400000,
            microLamports: swapData.params.priorityFee ? 
              Math.floor(swapData.params.priorityFee * LAMPORTS_PER_SOL / 400000) : 
              10000
          },
          txVersion: TxVersion.V0,
          slippage: slippageBN,
        });

        // Calculate Sendy fee (1% of input amount)
        const feeAmt = BigInt(inAmount.div(new BN(100)).toString());
        
        // Initialize instructions array and capture VersionedTransaction if included
        let instructions: TransactionInstruction[] = [];
        let versionedTransaction: VersionedTransaction | undefined;

        // If the SDK response includes a full transaction, capture it for direct use
        if (sdkResponse.transaction) {
          versionedTransaction = sdkResponse.transaction;
        }
        // Handle different SDK response formats when a full transaction wasn't provided
        else if (sdkResponse.builder) {
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
            console.error(`Error executing transaction: ${executeError}`);
            throw executeError;
          }
        }
        
        if (instructions.length === 0 && !versionedTransaction) {
          console.warn("No instructions were extracted from the SDK response");
          
          // If we couldn't extract instructions but have the transaction message,
          // we can include it directly as a serialized transaction
          if (sdkResponse.transaction) {
            console.info("Using the full transaction from SDK response");
          }
        }

        // Prepare result object with standard interface properties
        const result = {
          instructions: [...preparatoryInstructions, ...instructions],
          sendyFeeLamports: feeAmt,
          poolAddress: poolId,
          cleanupInstructions: [], 
        };
        
        // Attach the versioned transaction as a non-standard property
        if (versionedTransaction) {
          (result as any)._raydiumVersionedTx = versionedTransaction;
        }
        
        return result;
        
      } else if (isSell && effectiveIsBaseMint) {
        // Selling base token for quote token (SOL)
        const inAmount = new BN(Math.floor(amount * Math.pow(10, this.launchpadPoolInfo.mintDecimalsA)));
        
        // Calculate expected output using Curve calculations (for reference)
        const curveResult = Curve.sellExactIn({
          poolInfo: this.launchpadPoolInfo,
          amountA: inAmount,
          protocolFeeRate: this.launchpadPoolInfo.configInfo?.tradeFeeRate || new BN(0),
          platformFeeRate: platformInfo.feeRate,
          curveType: this.launchpadPoolInfo.configInfo?.curveType || 0,
          shareFeeRate,
        });
        
        // Calculate minimum amount out with slippage
        const minOutAmount = new BN(
          new Decimal(curveResult.amountB.toString())
            .mul((10000 - slippageBN.toNumber()) / 10000)
            .toFixed(0)
        );
        
        if (minOutAmount.lte(new BN(0))) {
          throw new Error("Swap amount too small: would receive 0 SOL. Try a larger amount.");
        }
        
        console.info(
          `Selling base token: Expected to receive ${curveResult.amountB.toString()} SOL, ` +
          `minimum with slippage: ${minOutAmount.toString()}`
        );
        
        // Use the SDK to create the sell transaction - following official example
        const sdkResponse = await raydium.launchpad.sellToken({
          programId: LAUNCHPAD_PROGRAM,
          mintA: this.launchpadPoolInfo.mintA,
          feePayer: new PublicKey(swapData.params.userWalletAddress),
          configInfo: this.launchpadPoolInfo.configInfo,
          sellAmount: inAmount,
          platformFeeRate: platformInfo.feeRate,
          computeBudgetConfig: {
            units: 400000,
            microLamports: swapData.params.priorityFee ? 
              Math.floor(swapData.params.priorityFee * LAMPORTS_PER_SOL / 400000) : 
              10000
          },
          txVersion: TxVersion.V0,
          slippage: slippageBN,
        });

        // Calculate Sendy fee (1% of output SOL amount)
        const feeAmt = BigInt(minOutAmount.div(new BN(100)).toString());
        
        // Initialize instructions array and capture VersionedTransaction if included
        let instructions: TransactionInstruction[] = [];
        let versionedTransaction: VersionedTransaction | undefined;

        // If the SDK response includes a full transaction, capture it for direct use
        if (sdkResponse.transaction) {
          versionedTransaction = sdkResponse.transaction;
        }
        // Handle different SDK response formats when a full transaction wasn't provided
        else if (sdkResponse.builder) {
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
            console.error(`Error executing transaction: ${executeError}`);
            throw executeError;
          }
        }
        
        if (instructions.length === 0 && !versionedTransaction) {
          console.warn("No instructions were extracted from the SDK response");
          
          // If we couldn't extract instructions but have the transaction message,
          // we can include it directly as a serialized transaction
          if (sdkResponse.transaction) {
            console.info("Using the full transaction from SDK response");
          }
        }
        
        // Prepare result object with standard interface properties
        const result = {
          instructions: [...preparatoryInstructions, ...instructions],
          sendyFeeLamports: feeAmt,
          poolAddress: poolId,
          cleanupInstructions: [],
        };
        
        // Attach the versioned transaction as a non-standard property
        if (versionedTransaction) {
          (result as any)._raydiumVersionedTx = versionedTransaction;
        }
        
        return result;
      } else {
        throw new Error(`Unsupported operation: ${type} for mint ${mintAddress}`);
      }
    } catch (error) {
      console.error(`Error generating swap instructions: ${error}`);
      throw new Error(`Failed to generate swap instructions: ${error}`);
    }
  }
}
