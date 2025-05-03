import {
  Connection,
  PublicKey,
  TransactionInstruction,
  LAMPORTS_PER_SOL,
  VersionedTransaction,
  SystemProgram,
} from "@solana/web3.js";
import { 
  Raydium, 
  TxVersion, 
  LAUNCHPAD_PROGRAM,
  PlatformConfig,
  Curve,
  getPdaLaunchpadPoolId
} from '@raydium-io/raydium-sdk-v2';
import { ISwapStrategy, GenerateInstructionsResult, SwapStrategyDependencies, TransactionProps } from "../base/ISwapStrategy";
import BN from "bn.js";
import Decimal from "decimal.js";
import { NATIVE_MINT } from "@solana/spl-token"; // Correct import
import { prepareTokenAccounts } from '../../../utils/tokenAccounts';
import { calculateSendyFee, makeSendyFeeInstruction } from '../../../utils/feeUtils';
import { FEE_RECIPIENT } from '../../constants';
import { ensureUserTokenAccounts } from '../utils/ensureTokenAccounts';
import { LaunchpadPool } from '@raydium-io/raydium-sdk-v2';

// If needed, can use the hardcoded value as fallback
// const LAUNCHPAD_PROGRAM_ID = new PublicKey("LanMkFSVSncjWqWAM8MUHenZzt9xTcT3DcAp949ZwbF");

export class RaydiumLaunchLabSwapStrategy implements ISwapStrategy {
  private launchpadPoolInfo: any | null = null;
  private readonly connection: Connection;
  private readonly userPublicKey: PublicKey;
  private raydiumSdk: Raydium | null = null;
  private versionedTransaction: VersionedTransaction | undefined = undefined;

  constructor(connection: Connection, userPublicKey: PublicKey) {
    this.connection = connection;
    this.userPublicKey = userPublicKey;
    console.info(`Initialized Raydium LaunchLab Strategy`);
  }

  private async initRaydiumSdk(): Promise<Raydium> {
    if (!this.raydiumSdk) {
      this.raydiumSdk = await Raydium.load({
        connection: this.connection,
        owner: this.userPublicKey,
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
      const { inputMint, outputMint, type } = swapData.params;
      const tokenMint = type === 'buy' ? outputMint : inputMint;
      if (tokenMint.toString().toLowerCase().endsWith('pump') || tokenMint.toString().toLowerCase().endsWith('moon')) {
        return false;
      }
      // Check Raydium Launchpad API for bonding status
      const apiUrl = `https://launch-mint-v1.raydium.io/get/by/mints?ids=${tokenMint.toString()}`;
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

  /**
   * Generates all instructions required for a Raydium LaunchLab swap, including:
   *   - Setup (ATA creation) instructions
   *   - Fee transfer (if needed)
   *   - The swap instruction(s) from Raydium SDK
   * All instructions are returned in a single array, in the correct order, for bundling into a single transaction.
   * No setup or side-effect instructions are sent outside this transaction.
   * If the SDK only returns a VersionedTransaction, this will be attached as a non-standard property.
   */
  async generateSwapInstructions(
    swapData: TransactionProps,
    dependencies: SwapStrategyDependencies
  ): Promise<GenerateInstructionsResult> {
    try {
      const raydium = await this.initRaydiumSdk();

      // Get mint address
      const mintAddress = new PublicKey(swapData.params.inputMint);
      // Calculate pool ID
      const mintA = mintAddress;
      const mintB = NATIVE_MINT; // Always using SOL as the quote token
      const poolId = this.getPoolId(mintA);

      // Ensure the user has ATAs for input and output mints using shared utility
      const preparatoryInstructions: TransactionInstruction[] = [];
      const mintsToEnsure = Array.from(new Set([mintA, mintB].map((m) => m.toString()))).map((s) => new PublicKey(s));
      await prepareTokenAccounts({
        connection: this.connection,
        userPublicKey: this.userPublicKey,
        mints: mintsToEnsure,
        instructions: preparatoryInstructions,
      });

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
      const platformInfo = PlatformConfig.decode(platformData.data);

      const { type, amount, slippageBps } = swapData.params;
      const shareFeeRate = new BN(0); // No share fee in our case
      const isBuy = type === 'buy';
      const isSell = type === 'sell';
      const isBaseMint = mintAddress.equals(this.launchpadPoolInfo.mintA);
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

      let instructions: TransactionInstruction[] = [];
      let versionedTransaction: VersionedTransaction | undefined;
      let feeAmt: bigint = 0n;
      if (isBuy && effectiveIsQuoteMint) {
        // Buying base token with quote token (SOL)
        const inAmount = new BN(Math.floor(Number(amount) * Math.pow(10, this.launchpadPoolInfo.mintDecimalsB)));
        const curveResult = Curve.buyExactIn({
          poolInfo: this.launchpadPoolInfo,
          amountB: inAmount,
          protocolFeeRate: this.launchpadPoolInfo.configInfo?.tradeFeeRate || new BN(0),
          platformFeeRate: platformInfo.feeRate,
          curveType: this.launchpadPoolInfo.configInfo?.curveType || 0,
          shareFeeRate,
        });
        const minOutAmount = new BN(
          new Decimal(curveResult.amountA.toString())
            .mul(new Decimal(10000 - slippageBps).div(10000).toNumber())
            .toFixed(0)
        );
        if (minOutAmount.lte(new BN(0))) {
          throw new Error("Swap amount too small: would receive 0 tokens. Try a larger amount.");
        }
        // Use the SDK to create the buy transaction
        const sdkResponse = await raydium.launchpad.buyToken({
          programId: LAUNCHPAD_PROGRAM,
          mintA: this.launchpadPoolInfo.mintA,
          feePayer: new PublicKey(swapData.params.userWalletAddress),
          configInfo: this.launchpadPoolInfo.configInfo,
          buyAmount: inAmount,
          platformFeeRate: platformInfo.feeRate,
          computeBudgetConfig: undefined, // Leave compute budget for transaction builder
          txVersion: TxVersion.V0,
          slippage: new BN(slippageBps),
        });
        feeAmt = BigInt(inAmount.div(new BN(100)).toString());
        // Extract instructions from SDK response
        if (sdkResponse.transaction) {
          versionedTransaction = sdkResponse.transaction;
        } else if (sdkResponse.builder) {
          const txBuilder = sdkResponse.builder;
          instructions = txBuilder.allInstructions || [];
        } else if (sdkResponse.execute) {
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
      } else if (isSell && effectiveIsBaseMint) {
        // Selling base token for quote token (SOL)
        const inAmount = new BN(Math.floor(Number(amount) * Math.pow(10, this.launchpadPoolInfo.mintDecimalsA)));
        const curveResult = Curve.sellExactIn({
          poolInfo: this.launchpadPoolInfo,
          amountA: inAmount,
          protocolFeeRate: this.launchpadPoolInfo.configInfo?.tradeFeeRate || new BN(0),
          platformFeeRate: platformInfo.feeRate,
          curveType: this.launchpadPoolInfo.configInfo?.curveType || 0,
          shareFeeRate,
        });
        const minOutAmount = new BN(
          new Decimal(curveResult.amountB.toString())
            .mul(new Decimal(10000 - slippageBps).div(10000).toNumber())
            .toFixed(0)
        );
        if (minOutAmount.lte(new BN(0))) {
          throw new Error("Swap amount too small: would receive 0 SOL. Try a larger amount.");
        }
        const sdkResponse = await raydium.launchpad.sellToken({
          programId: LAUNCHPAD_PROGRAM,
          mintA: this.launchpadPoolInfo.mintA,
          feePayer: new PublicKey(swapData.params.userWalletAddress),
          configInfo: this.launchpadPoolInfo.configInfo,
          sellAmount: inAmount,
          platformFeeRate: platformInfo.feeRate,
          computeBudgetConfig: undefined, // Leave compute budget for transaction builder
          txVersion: TxVersion.V0,
          slippage: new BN(slippageBps),
        });
        feeAmt = BigInt(minOutAmount.div(new BN(100)).toString());
        if (sdkResponse.transaction) {
          versionedTransaction = sdkResponse.transaction;
        } else if (sdkResponse.builder) {
          const txBuilder = sdkResponse.builder;
          instructions = txBuilder.allInstructions || [];
        } else if (sdkResponse.execute) {
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
      } else {
        throw new Error(`Unsupported operation: ${type} for mint ${mintAddress}`);
      }

      // Ensure user token accounts exist for input and output mints
      const inputMint = isBuy ? mintB : mintA;
      const outputMint = isBuy ? mintA : mintB;
      const launchlabPreparatoryInstructions = instructions;
      await ensureUserTokenAccounts({
        connection: this.connection,
        userPublicKey: this.userPublicKey,
        mints: [inputMint, outputMint],
        preparatoryInstructions: launchlabPreparatoryInstructions,
      });

      // --- Fee Transfer Instruction ---
      let feeInstruction: TransactionInstruction | undefined = undefined;
      if (feeAmt > 0n) {
        feeInstruction = makeSendyFeeInstruction({
          from: new PublicKey(swapData.params.userWalletAddress),
          to: FEE_RECIPIENT,
          lamports: Number(feeAmt),
        });
      }

      // --- Concatenate all instructions in correct order ---
      const allInstructions: TransactionInstruction[] = [
        ...preparatoryInstructions,
        ...(feeInstruction ? [feeInstruction] : []),
        ...instructions,
      ];

      const result: GenerateInstructionsResult = {
        success: true,
        instructions: allInstructions,
        sendyFeeLamports: Number(feeAmt),
        poolAddress: poolId,
        cleanupInstructions: [],
      };
      if (versionedTransaction) {
        (result as any)._raydiumVersionedTx = versionedTransaction;
      }
      return result;
    } catch (error) {
      console.error(`Error generating swap instructions: ${error}`);
      throw new Error(`Failed to generate swap instructions: ${error}`);
    }
  }
}
