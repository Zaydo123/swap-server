import {
  Connection,
  PublicKey,
  TransactionInstruction,
  Keypair,
  LAMPORTS_PER_SOL,
  VersionedTransaction,
  AddressLookupTableAccount,
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
import { NATIVE_MINT } from "@solana/spl-token";
import Decimal from "decimal.js";
import { ensureUserTokenAccounts } from '../utils/ensureTokenAccounts';
import { LaunchpadPool } from '@raydium-io/raydium-sdk-v2';

// If needed, can use the hardcoded value as fallback
// const LAUNCHPAD_PROGRAM_ID = new PublicKey("LanMkFSVSncjWqWAM8MUHenZzt9xTcT3DcAp949ZwbF");

export class RaydiumLaunchLabSwapStrategy implements ISwapStrategy {
  private launchpadPoolInfo: any | null = null;
  private readonly connection: Connection;
  private raydiumSdk: Raydium | null = null;
  // Removed versionedTransaction state, it's part of the result now

  constructor(connection: Connection) {
    this.connection = connection;
    console.info(`Initialized Raydium LaunchLab Strategy`);
  }

  private async initRaydiumSdk(walletOwner: Keypair): Promise<Raydium> {
    if (!this.raydiumSdk) {
      this.raydiumSdk = await Raydium.load({
        connection: this.connection,
        owner: walletOwner,
        cluster: 'mainnet',
        disableFeatureCheck: false,
      });
    }
    return this.raydiumSdk;
  }

  // Use SDK's getPdaLaunchpadPoolId method
  private getPoolId(mintAddress: PublicKey): PublicKey {
    // Ensure LAUNCHPAD_PROGRAM is imported correctly
    if (!LAUNCHPAD_PROGRAM) {
        throw new Error("LAUNCHPAD_PROGRAM address is not defined/imported.");
    }
    // Use the direct argument signature
    return getPdaLaunchpadPoolId(LAUNCHPAD_PROGRAM, mintAddress, NATIVE_MINT).publicKey;
  }

  async canHandle(swapData: TransactionProps, dependencies: SwapStrategyDependencies): Promise<boolean> {
    try {
      // Define type before use
      const { type } = swapData.params;
      const mintAddressStr = type === 'buy' ? swapData.params.outputMint : swapData.params.inputMint;
      // Input validation: Ensure necessary params exist
      if (!mintAddressStr) {
          console.warn("RaydiumLaunchLabSwapStrategy: mintAddress missing in params.");
          return false;
      }
      
      // Ignore pump/moon tokens
      if (mintAddressStr.toLowerCase().includes('pump') || mintAddressStr.toLowerCase().includes('moon')) {
        console.log(`RaydiumLaunchLabSwapStrategy: Ignoring pump/moon token ${mintAddressStr}.`);
        return false;
      }

      // Check Raydium Launchpad API for bonding status
      const apiUrl = `https://launch-mint-v1.raydium.io/get/by/mints?ids=${mintAddressStr}`;
      try {
        console.log(`RaydiumLaunchLabSwapStrategy: Checking bonding status via ${apiUrl}`);
        const response = await fetch(apiUrl);
        if (!response.ok) {
            console.warn(`RaydiumLaunchLabSwapStrategy: API check failed (${response.status}) for ${mintAddressStr}.`);
            return false;
        }
        const data = await response.json();
        const row = data?.data?.rows?.[0];
        if (!row) {
            console.warn(`RaydiumLaunchLabSwapStrategy: No data row found for ${mintAddressStr} in API response.`);
            return false;
        }
        
        // Explicitly check for 'bonded: false' or finishingRate < 100
        const isBonded = row.bonded === true || (row.finishingRate != null && Number(row.finishingRate) >= 100);

        if (!isBonded) {
          console.info(`RaydiumLaunchLabSwapStrategy: Token ${mintAddressStr} is NOT bonded (bonded: ${row.bonded}, finishingRate: ${row.finishingRate}). CAN handle.`);
          return true;
        } else {
          console.info(`RaydiumLaunchLabSwapStrategy: Token ${mintAddressStr} IS bonded (bonded: ${row.bonded}, finishingRate: ${row.finishingRate}). Will NOT handle.`);
          return false;
        }
      } catch (apiErr) {
        console.warn('RaydiumLaunchLabSwapStrategy: Error checking bonding status via API:', apiErr);
        return false; // Treat API errors as cannot handle
      }
    } catch (error) {
      console.error(`RaydiumLaunchLabSwapStrategy canHandle error: ${error}`);
      return false;
    }
  }

  // This helper is not needed as entrypoint handles the versioned tx directly
  /*
  private extractInstructionsFromVersionedTransaction(versionedTx: VersionedTransaction): TransactionInstruction[] {
    // ... implementation ...
    return [];
  }
  */

  async generateSwapInstructions(
    swapData: TransactionProps,
    dependencies: SwapStrategyDependencies // Use dependencies passed in
  ): Promise<GenerateInstructionsResult> {
     // Use connection and userPublicKey from dependencies
     const connection = dependencies.connection;
     const userPublicKey = dependencies.userPublicKey;
 
     console.log('Generating LaunchLab instructions for wallet:', userPublicKey.toBase58());

    try {
      // We need a temporary Keypair for SDK init owner, but strategies shouldn't hold secrets.
      // This highlights a design issue - SDK init needs owner, but strategy shouldn't have Keypair.
      // For now, create a dummy Keypair with the correct public key for SDK load.
      // A better long-term solution might involve initializing SDK elsewhere or adjusting strategy interface.
      const tempOwnerForSdkInit = Keypair.generate(); // Create dummy
      Object.defineProperty(tempOwnerForSdkInit, 'publicKey', { value: userPublicKey, writable: false }); // Set correct pubkey
      
      const raydium = await this.initRaydiumSdk(tempOwnerForSdkInit); 

      // Get mint address based on swap type
      const isBuy = swapData.params.type === 'buy';
      const mintAddress = new PublicKey(isBuy ? swapData.params.outputMint : swapData.params.inputMint);
      
      // Calculate pool ID
      const mintA = mintAddress; // Base token is always the non-SOL token
      const mintB = NATIVE_MINT; // Quote token is always SOL
      const poolId = this.getPoolId(mintA);
      
      console.info(`Generating LaunchLab swap instructions for pool ${poolId.toBase58()} (Token: ${mintA.toBase58()})`);

      // Ensure the user has ATAs for input and output mints
      const preparatoryInstructions: TransactionInstruction[] = [];
      const mintsToEnsure = [mintA, mintB]; // Base and Quote mints
      await ensureUserTokenAccounts({
        connection: connection, 
        userPublicKey: userPublicKey, // Use userPublicKey
        mints: mintsToEnsure,
        preparatoryInstructions
      });

      // Fetch pool info using the SDK - proper way
      console.log(`Fetching pool info for ${poolId.toBase58()}...`);
      this.launchpadPoolInfo = await raydium.launchpad.getRpcPoolInfo({ poolId });
      
      if (!this.launchpadPoolInfo || !this.launchpadPoolInfo.configInfo) { // Check configInfo too
        throw new Error(`Failed to fetch valid pool info (or configInfo) for ${poolId.toBase58()}`);
      }
      console.log(`Pool info fetched successfully.`);
      
      // Fetch and decode platform info
      console.log(`Fetching platform info for ${this.launchpadPoolInfo.platformId.toBase58()}...`);
      const platformData = await connection.getAccountInfo(this.launchpadPoolInfo.platformId);
      if (!platformData) {
        throw new Error(`Failed to fetch platform data for ${this.launchpadPoolInfo.platformId.toBase58()}`);
      }
      
      // Decode platform data using the SDK's PlatformConfig
      const platformInfo = PlatformConfig.decode(platformData.data);
      console.log(`Platform info fetched successfully.`);
      
      const { type, amount, slippageBps } = swapData.params; // Use slippageBps
      // Ensure amount is a number before using in arithmetic
      const amountNum = Number(amount);
      if (isNaN(amountNum)) {
        throw new Error(`Invalid amount provided: ${amount}`);
      }

      const slippageBN = new BN(slippageBps); // Slippage is already in BPS
      const shareFeeRate = new BN(0); // No share fee in our case

      let versionedTransaction: VersionedTransaction | undefined;
      let feeAmt = 0n; // Use bigint for fees
      let sdkResponse: any;

      if (isBuy) {
        // Buying base token (mintA) with quote token (SOL - mintB)
        // Amount is in SOL, convert to lamports
        const inAmountLamports = new BN(Math.floor(amountNum * LAMPORTS_PER_SOL));
        console.log(`Buy operation: Input ${amount} SOL (${inAmountLamports.toString()} lamports)`);
        
        // Calculate expected output using Curve (for logging/validation)
        // Note: SDK handles minAmountOut internally based on slippage
        const curveResult = Curve.buyExactIn({
          poolInfo: this.launchpadPoolInfo,
          amountB: inAmountLamports, // SOL amount in
          protocolFeeRate: this.launchpadPoolInfo.configInfo?.tradeFeeRate || new BN(0),
          platformFeeRate: platformInfo.feeRate,
          curveType: this.launchpadPoolInfo.configInfo?.curveType || 0,
          shareFeeRate,
        });
        
        console.info(
          `Buying base token: Expected to receive approx ${curveResult.amountA.toString()} base tokens (before slippage)`
        );
        
        // Use the SDK to create the buy transaction
        sdkResponse = await raydium.launchpad.buyToken({
          programId: LAUNCHPAD_PROGRAM, // Use imported constant
          mintA: this.launchpadPoolInfo.mintA,
          feePayer: userPublicKey, // Use userPublicKey
          configInfo: this.launchpadPoolInfo.configInfo,
          buyAmount: inAmountLamports, // Amount in lamports (SOL)
          platformFeeRate: platformInfo.feeRate,
          computeBudgetConfig: undefined, // Let SDK handle compute budget or use default
          // computeBudgetConfig: { // Example if specific budget needed
          //   units: 400000,
          //   microLamports: swapData.params.priorityFee ? 
          //     Math.floor(swapData.params.priorityFee * LAMPORTS_PER_SOL / 400000) : 
          //     10000
          // },
          txVersion: TxVersion.V0,
          slippage: slippageBN, // Pass slippage in BPS
        });

        // Calculate Sendy fee (1% of input SOL amount)
        feeAmt = BigInt(inAmountLamports.div(new BN(100)).toString());
        console.log(`Calculated Sendy fee (1% of input SOL): ${feeAmt.toString()} lamports`);
      } else { // Sell operation
        // Selling base token (mintA) for quote token (SOL - mintB)
        // Amount is in token units, convert to base units
        const inAmountBaseUnits = new BN(Math.floor(amountNum * Math.pow(10, this.launchpadPoolInfo.mintDecimalsA)));
        console.log(`Sell operation: Input ${amount} ${mintA.toBase58()} (${inAmountBaseUnits.toString()} base units)`);

        // Calculate expected output using Curve calculations (for reference)
        const curveResult = Curve.sellExactIn({
          poolInfo: this.launchpadPoolInfo,
          amountA: inAmountBaseUnits, // Token amount in base units
          protocolFeeRate: this.launchpadPoolInfo.configInfo?.tradeFeeRate || new BN(0),
          platformFeeRate: platformInfo.feeRate,
          curveType: this.launchpadPoolInfo.configInfo?.curveType || 0,
          shareFeeRate,
        });
        
        // Calculate minimum amount out (SOL in lamports) with slippage
        const minOutAmountLamports = new BN(
          new Decimal(curveResult.amountB.toString()) // SOL output in lamports
            .mul((10000 - slippageBN.toNumber()) / 10000)
            .toFixed(0)
        );
        
        if (minOutAmountLamports.lte(new BN(0))) {
          throw new Error("Swap amount too small: would receive 0 SOL. Try a larger amount.");
        }
        
        console.info(
          `Selling base token: Expected to receive ${curveResult.amountB.toString()} lamports, ` +
          `minimum with slippage: ${minOutAmountLamports.toString()} lamports`
        );
        
        // Use the SDK to create the sell transaction
        sdkResponse = await raydium.launchpad.sellToken({
          programId: LAUNCHPAD_PROGRAM, // Use imported constant
          mintA: this.launchpadPoolInfo.mintA,
          feePayer: userPublicKey, // Use userPublicKey
          configInfo: this.launchpadPoolInfo.configInfo,
          sellAmount: inAmountBaseUnits, // Amount in token base units
          platformFeeRate: platformInfo.feeRate,
          computeBudgetConfig: undefined, // Let SDK handle compute budget or use default
          // computeBudgetConfig: { // Example if specific budget needed
          //   units: 400000,
          //   microLamports: swapData.params.priorityFee ? 
          //     Math.floor(swapData.params.priorityFee * LAMPORTS_PER_SOL / 400000) : 
          //     10000
          // },
          txVersion: TxVersion.V0,
          slippage: slippageBN, // Pass slippage in BPS
        });

        // Calculate Sendy fee (1% of minimum output SOL amount)
        feeAmt = BigInt(minOutAmountLamports.div(new BN(100)).toString());
        console.log(`Calculated Sendy fee (1% of min output SOL): ${feeAmt.toString()} lamports`);
      }
      
      // Extract ONLY the transaction from SDK response
      if (sdkResponse.transaction) {
          versionedTransaction = sdkResponse.transaction;
      } else {
         // Attempt fallback if execute method exists
         if (sdkResponse.execute) {
             try {
                 const transaction = await sdkResponse.execute();
                 if (transaction && transaction instanceof VersionedTransaction) {
                    versionedTransaction = transaction;
                 } else {
                    throw new Error("Execute method did not return a VersionedTransaction.");
                 }
             } catch (executeError) {
                 console.error(`Error executing transaction from SDK: ${executeError}`);
                 throw executeError;
             }
         } else {
             throw new Error("Raydium Launchpad SDK did not provide a usable transaction.");
         }
      }
      
      // --- Prepare Result --- 
      // Extract TransactionInstructions from the versioned transaction
      let swapInstructions: TransactionInstruction[] = [];
      if (versionedTransaction) {
        // Fetch lookup tables if present
        const lookupTables = versionedTransaction.message.addressTableLookups
          ? await Promise.all(
              versionedTransaction.message.addressTableLookups.map(
                lookup => connection.getAddressLookupTable(lookup.accountKey).then(res => res.value)
              )
            ).then(tables => tables.filter((table): table is AddressLookupTableAccount => table !== null))
          : [];
        const accountKeys = versionedTransaction.message.getAccountKeys({ addressLookupTableAccounts: lookupTables });
        swapInstructions = versionedTransaction.message.compiledInstructions.map(ix => {
          const programId = accountKeys.get(ix.programIdIndex);
          if (!programId) return undefined;
          const keys = ix.accountKeyIndexes.map(idx => {
            const pubkey = accountKeys.get(idx);
            if (!pubkey) return undefined;
            return {
              pubkey,
              isSigner: versionedTransaction.message.isAccountSigner(idx),
              isWritable: versionedTransaction.message.isAccountWritable(idx),
            };
          }).filter((k): k is { pubkey: PublicKey; isSigner: boolean; isWritable: boolean } => !!k);
          return new TransactionInstruction({
            programId,
            keys,
            data: Buffer.from(ix.data),
          });
        }).filter((ix): ix is TransactionInstruction => !!ix);
      }

      const result: GenerateInstructionsResult = {
        success: true,
        instructions: swapInstructions, // Return extracted instructions
        sendyFeeLamports: Number(feeAmt),
        poolAddress: poolId,
        cleanupInstructions: [],
        addressLookupTables: versionedTransaction?.message.addressTableLookups
          ? await Promise.all(versionedTransaction.message.addressTableLookups.map(
              lookup => connection.getAddressLookupTable(lookup.accountKey).then(res => res.value)
            )).then(tables => tables.filter((table): table is AddressLookupTableAccount => table !== null))
          : [],
        // Do NOT set versionedTransaction!
      };
      
      console.log("Returning extracted instructions and calculated fee from Launchpad strategy.");
      return result;
      
    } catch (error) {
      console.error(`Error generating Launchpad swap instructions: ${error}`, error);
      // Ensure a proper error structure is returned
      return { 
          success: false, 
          error: `Failed to generate Launchpad swap instructions: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }
}