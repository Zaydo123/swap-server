import { Connection, Keypair, PublicKey, SendOptions, Transaction, VersionedTransaction, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { createCloseAccountInstruction, getAssociatedTokenAddress, TOKEN_PROGRAM_ID } from '@solana/spl-token';

export const NATIVE_MINT = new PublicKey('So11111111111111111111111111111111111111112');

export async function sendTransactionWithWSOLFallback(
  connection: Connection,
  transaction: Transaction | VersionedTransaction,
  signer: Keypair,
  options: SendOptions = { skipPreflight: false, maxRetries: 3 }
): Promise<string> {
  try {
    // First try to send the transaction normally
    const signature = transaction instanceof Transaction 
      ? await connection.sendTransaction(transaction, [signer], options)
      : await connection.sendTransaction(transaction, options);
    
    console.log('Transaction sent with signature:', signature);
    return signature;
  } catch (error) {
    console.error('Transaction failed:', error);
    
    // Check if error is due to insufficient lamports
    const errorMessage = error instanceof Error ? error.message : String(error);
    const isInsufficientLamports = 
      errorMessage.includes('insufficient lamports') || 
      errorMessage.includes('0x1') || // Solana error code for insufficient lamports
      errorMessage.includes('Insufficient funds');
    
    // Also check for signature verification failures - sometimes these are due to low SOL balance
    const isSignatureError = errorMessage.includes('signature verification failed');
    
    if (isInsufficientLamports || isSignatureError) {
      console.log('Detected insufficient lamports error, checking for wrapped SOL...');
      
      // Check for wrapped SOL account
      const userWrappedSolAccount = await getAssociatedTokenAddress(
        NATIVE_MINT,
        signer.publicKey,
        false // Allow off-curve addresses
      );

      // Get wrapped SOL balance
      try {
        const tokenAccountInfo = await connection.getTokenAccountBalance(userWrappedSolAccount);
        const wrappedSolBalance = tokenAccountInfo.value.uiAmount || 0;
        
        if (wrappedSolBalance > 0) {
          console.log(`Found ${wrappedSolBalance} wrapped SOL, unwrapping and retrying transaction...`);
          
          // Create close account instruction to unwrap SOL
          const closeInstruction = createCloseAccountInstruction(
            userWrappedSolAccount,
            signer.publicKey, // Destination for remaining SOL rent
            signer.publicKey  // Authority
          );
          
          // Create and send unwrap transaction
          const unwrapTx = new Transaction().add(closeInstruction);
          const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
          unwrapTx.recentBlockhash = blockhash;
          unwrapTx.feePayer = signer.publicKey;
          
          try {
            // Send unwrap transaction
            const unwrapSignature = await connection.sendTransaction(unwrapTx, [signer], {
              skipPreflight: true
            });
            console.log('Unwrap transaction sent with signature:', unwrapSignature);
            
            // Wait for unwrap confirmation
            await connection.confirmTransaction({
              signature: unwrapSignature,
              blockhash,
              lastValidBlockHeight
            }, 'confirmed');
            console.log('Unwrap transaction confirmed successfully');
            
            // Get a fresh blockhash before retrying
            const { blockhash: newBlockhash, lastValidBlockHeight: newLastValidBlockHeight } = 
              await connection.getLatestBlockhash('confirmed');
            
            // Apply the new blockhash to the transaction before retrying
            if (transaction instanceof Transaction) {
              transaction.recentBlockhash = newBlockhash;
              transaction.feePayer = signer.publicKey;
              transaction.sign(signer);
            } else {
              // For VersionedTransaction we need to rebuild with the new blockhash
              // This assumes the Raydium transaction generator will handle this when retrying
              console.log('Refreshing blockhash for versioned transaction...');
            }
            
            // Small delay to allow the network to process the unwrap transaction
            await new Promise(resolve => setTimeout(resolve, 2000));
            
            // Retry original transaction after unwrapping
            const retrySignature = transaction instanceof Transaction 
              ? await connection.sendTransaction(transaction, [signer], options)
              : await connection.sendTransaction(transaction, options);
            
            console.log('Transaction retried successfully after unwrapping WSOL, signature:', retrySignature);
            return retrySignature;
          } catch (unwrapError) {
            console.error('Error unwrapping SOL:', unwrapError);
            throw new Error(`Failed to unwrap SOL: ${unwrapError instanceof Error ? unwrapError.message : String(unwrapError)}`);
          }
        } else {
          console.log('No wrapped SOL found or balance is zero');
          throw new Error('Insufficient SOL balance. Please add more SOL to your wallet.');
        }
      } catch (tokenAccountError) {
        console.log('No wrapped SOL account found:', tokenAccountError);
        throw new Error('Insufficient SOL balance. Please add more SOL to your wallet.');
      }
    } else if (errorMessage.includes('expired') || errorMessage.includes('block height exceeded')) {
      console.log('Transaction expired, refreshing blockhash and retrying...');
      
      try {
        // Get a fresh blockhash
        const { blockhash: newBlockhash } = await connection.getLatestBlockhash('confirmed');
        
        // Apply the new blockhash to the transaction
        if (transaction instanceof Transaction) {
          transaction.recentBlockhash = newBlockhash;
          transaction.feePayer = signer.publicKey;
          transaction.sign(signer);
        } else {
          // For VersionedTransaction we need to rebuild with the new blockhash
          // This assumes the Raydium transaction generator will handle this when retrying
          console.log('Refreshing blockhash for versioned transaction...');
        }
        
        // Retry with the new blockhash
        const retrySignature = transaction instanceof Transaction 
          ? await connection.sendTransaction(transaction, [signer], options)
          : await connection.sendTransaction(transaction, options);
        
        console.log('Transaction retried successfully with new blockhash, signature:', retrySignature);
        return retrySignature;
      } catch (retryError) {
        console.error('Error retrying transaction:', retryError);
        throw new Error(`Failed to retry transaction: ${retryError instanceof Error ? retryError.message : String(retryError)}`);
      }
    } else {
      // Not an insufficient lamports error, rethrow
      throw error;
    }
  }
} 