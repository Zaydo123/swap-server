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

  // Serialize transactions to base64 for API return
  const serializedTransactions = result.transactions.map(tx => {
    if ('serialize' in tx) {
      // VersionedTransaction
      return (tx as any).serialize().toString('base64');
    } else if ('compileToV0Message' in tx) {
      // TransactionMessage
      const messageV0 = (tx as any).compileToV0Message();
      // Create a VersionedTransaction for serialization
      const { VersionedTransaction } = require('@solana/web3.js');
      const vtx = new VersionedTransaction(messageV0);
      return vtx.serialize().toString('base64');
    } else {
      throw new Error('Unknown transaction type for serialization');
    }
  });

  // Return the new structure
  return {
    success: result.success,
    transactions: serializedTransactions,
    txCount: result.txCount,
    swapInstructions: result.swapInstructions,
    cleanupInstructions: result.cleanupInstructions,
    feeAmountLamports: result.feeAmountLamports,
    poolAddress: result.poolAddress,
    error: result.error,
  };
} 