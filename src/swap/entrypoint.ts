import { Connection } from '@solana/web3.js';
import { generateSwapTransaction, TransactionProps } from './swap';

// Make TransactionProps.secret optional for unsigned tx generation
export type UnsignedTransactionProps = Omit<TransactionProps, 'secret'>;

export async function buildUnsignedSwapTransaction(
  transactionDetails: UnsignedTransactionProps,
  heliusRpcUrl: string,
  connection: Connection
) {
  // Call generateSwapTransaction with a dummy secret if required
  const result = await generateSwapTransaction(
    { ...transactionDetails, secret: '' } as TransactionProps,
    heliusRpcUrl,
    connection
  );

  // Return only the unsigned transaction and metadata
  return {
    success: result.success,
    transactionMessageOrTx: result.transactionMessageOrTx,
    swapInstructions: result.swapInstructions,
    cleanupInstructions: result.cleanupInstructions,
    feeAmountLamports: result.feeAmountLamports,
    poolAddress: result.poolAddress,
    needsSeparateSendyFeeTx: result.needsSeparateSendyFeeTx,
    error: result.error,
  };
} 