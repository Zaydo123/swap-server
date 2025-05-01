// Cleaned up swap.ts for Node.js environment
import { decodeSecretKey } from '../utils/decode';
import {
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddress,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createCloseAccountInstruction,
  NATIVE_MINT
} from '@solana/spl-token';
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
  TransactionInstruction,
  Signer,
  Message
} from '@solana/web3.js';
import * as CNST from './constants';
import { generateAuthHeaders } from '../utils/auth';
import { Buffer } from 'buffer';
import { SENDY_FEE_ACCOUNT } from './constants';
import { sendTransactionWithWSOLFallback } from './utils';
import { getSwapStrategy } from './swaps/router';
import { ISwapStrategy, SwapStrategyDependencies, GenerateInstructionsResult } from './swaps/base/ISwapStrategy';

// ... rest of the swap.ts logic, with all polyfill and expo-crypto imports removed ... 

export type TransactionProps = {
  params: {
    pairAddress: string;
    mintAddress: string;
    targetMint?: string;
    baseMint?: string;
    type: 'buy' | 'sell';
    amount: number;
    amountIsInSol: boolean;
    userWalletAddress: string;
    briberyAmount?: number;
    priorityFee?: number;
    slippage: number;
    computeUnitPrice?: number;
    devMode?: boolean;
  };
  secret?: string;
};

export async function generateSwapTransaction(
  transactionDetails: TransactionProps,
  heliusRpcUrl: string,
  connection: Connection
): Promise<{
  success: boolean;
  transactionMessageOrTx?: TransactionMessage | VersionedTransaction;
  swapInstructions?: TransactionInstruction[];
  cleanupInstructions?: TransactionInstruction[];
  feeAmountLamports?: bigint;
  poolAddress?: PublicKey;
  error?: any;
  needsSeparateSendyFeeTx: boolean;
}> {
  try {
    // --- 1. Handle Associated Token Account --- //
    const ataInstructions: TransactionInstruction[] = [];
    const userWalletAddress = new PublicKey(transactionDetails.params.userWalletAddress);
    const tokenAddress = new PublicKey(transactionDetails.params.mintAddress);
    const userAssociatedTokenAccount = await getAssociatedTokenAddress(
      tokenAddress,
      userWalletAddress,
      false
    );
    const ataInfo = await connection.getAccountInfo(userAssociatedTokenAccount);
    if (!ataInfo) {
      const cataInstruction = createAssociatedTokenAccountInstruction(
        userWalletAddress,
        userAssociatedTokenAccount,
        userWalletAddress,
        tokenAddress
      );
      ataInstructions.push(cataInstruction);
    }

    // --- 2. Select Swap Strategy --- //
    // Use a dummy Keypair for wallet (not used for signing)
    const dummyKeypair = Keypair.generate();
    Object.defineProperty(dummyKeypair, 'publicKey', {
      value: userWalletAddress,
      writable: false
    });
    let strategyDependencies: SwapStrategyDependencies = {
      connection,
      heliusRpcUrl: heliusRpcUrl,
      wallet: dummyKeypair
    };
    const strategy = await getSwapStrategy(transactionDetails, strategyDependencies);

    // --- 3. Generate Swap Instructions/Transaction via Strategy --- //
    interface StrategyResult extends GenerateInstructionsResult {
      _raydiumVersionedTx?: VersionedTransaction;
    }
    const result = await strategy.generateSwapInstructions(
      transactionDetails,
      strategyDependencies
    ) as StrategyResult;

    let transactionMessageOrTx: TransactionMessage | VersionedTransaction | undefined;
    let needsSeparateSendyFeeTx = false;
    if ((result as any)._raydiumVersionedTx instanceof VersionedTransaction) {
      let raydiumTx = (result as any)._raydiumVersionedTx as VersionedTransaction;
      if (result.sendyFeeLamports && result.sendyFeeLamports > 0n) {
        needsSeparateSendyFeeTx = true;
      }
      transactionMessageOrTx = raydiumTx;
    } else if (result.instructions && result.instructions.length > 0) {
      let allInstructions = [...ataInstructions, ...result.instructions];
      if (result.sendyFeeLamports && result.sendyFeeLamports > 0n) {
        const feeInstruction = SystemProgram.transfer({
          fromPubkey: userWalletAddress,
          toPubkey: SENDY_FEE_ACCOUNT,
          lamports: Number(result.sendyFeeLamports)
        });
        allInstructions.unshift(feeInstruction);
      }
      const { blockhash } = await connection.getLatestBlockhash();
      transactionMessageOrTx = new TransactionMessage({
        payerKey: userWalletAddress,
        recentBlockhash: blockhash,
        instructions: allInstructions,
      });
    } else {
      throw new Error('Swap strategy did not return a transaction or instructions.');
    }

    return {
      success: true,
      transactionMessageOrTx: transactionMessageOrTx,
      swapInstructions: result.instructions,
      cleanupInstructions: result.cleanupInstructions,
      feeAmountLamports: result.sendyFeeLamports || 0n,
      poolAddress: result.poolAddress,
      needsSeparateSendyFeeTx,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to generate swap transaction',
      needsSeparateSendyFeeTx: false,
    };
  }
} 