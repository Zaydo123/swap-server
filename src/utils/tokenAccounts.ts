import { Connection, PublicKey, TransactionInstruction, SystemProgram } from '@solana/web3.js';
import { NATIVE_MINT, getAssociatedTokenAddress, createAssociatedTokenAccountInstruction, createSyncNativeInstruction, createCloseAccountInstruction } from '@solana/spl-token';

/**
 * Prepares all necessary ATA creation instructions for a set of mints.
 * Optionally handles WSOL wrapping/unwrapping if SOL is involved.
 * Returns a map of mint -> associated token account.
 */
export async function prepareTokenAccounts({
  connection,
  userPublicKey,
  mints,
  instructions,
  wsolHandling
}: {
  connection: Connection,
  userPublicKey: PublicKey,
  mints: PublicKey[],
  instructions: TransactionInstruction[],
  wsolHandling?: { wrap?: boolean, unwrap?: boolean, amount?: bigint }
}): Promise<{ ataMap: Record<string, PublicKey> }> {
  const ataMap: Record<string, PublicKey> = {};
  for (const mint of mints) {
    const ata = await getAssociatedTokenAddress(mint, userPublicKey, false);
    ataMap[mint.toString()] = ata;
    const accountInfo = await connection.getAccountInfo(ata);
    if (!accountInfo) {
      instructions.push(createAssociatedTokenAccountInstruction(userPublicKey, ata, userPublicKey, mint));
    }
  }
  // WSOL handling
  if (wsolHandling && wsolHandling.wrap) {
    const wsolAta = await getAssociatedTokenAddress(NATIVE_MINT, userPublicKey, false);
    const wsolAccountInfo = await connection.getAccountInfo(wsolAta);
    if (!wsolAccountInfo) {
      instructions.push(createAssociatedTokenAccountInstruction(userPublicKey, wsolAta, userPublicKey, NATIVE_MINT));
    }
    instructions.push(createSyncNativeInstruction(wsolAta));
    if (wsolHandling.amount && wsolHandling.amount > 0n) {
      // Check current balance if account exists
      let requiredLamports = wsolHandling.amount;
      if (wsolAccountInfo) {
        const currentLamports = BigInt(wsolAccountInfo.lamports);
        if (currentLamports < wsolHandling.amount) {
          requiredLamports = wsolHandling.amount - currentLamports;
        } else {
          requiredLamports = 0n; // Already has enough
        }
      }
      // Only transfer if needed
      if (requiredLamports > 0n) {
        instructions.push(SystemProgram.transfer({
          fromPubkey: userPublicKey,
          toPubkey: wsolAta,
          lamports: Number(requiredLamports),
        }));
      }
    }
  }
  if (wsolHandling && wsolHandling.unwrap) {
    const wsolAta = await getAssociatedTokenAddress(NATIVE_MINT, userPublicKey, false);
    instructions.push(createCloseAccountInstruction(wsolAta, userPublicKey, userPublicKey));
  }
  return { ataMap };
}

// Utility: Add WSOL unwrap (close account) instruction if outputMint is WSOL and WSOL balance is nonzero
export async function addWsolUnwrapInstructionIfNeeded({
  outputMint,
  userPublicKey,
  instructions,
  connection
}: {
  outputMint: string,
  userPublicKey: PublicKey,
  instructions: TransactionInstruction[],
  connection: Connection
}) {
  if (outputMint === NATIVE_MINT.toBase58()) {
    const wsolAta = await getAssociatedTokenAddress(NATIVE_MINT, userPublicKey, false);
    const tokenInfo = await connection.getTokenAccountBalance(wsolAta).catch(() => undefined);
    if (tokenInfo?.value && Number(tokenInfo.value.amount) > 0) {
      instructions.push(
        createCloseAccountInstruction(wsolAta, userPublicKey, userPublicKey)
      );
    }
  }
}

/**
 * Adds an instruction to close the token account if a sell transaction would result in zero balance.
 * This is useful to recover rent when selling all tokens of a particular type.
 * 
 * @param {Object} params - Parameters
 * @param {Connection} params.connection - Solana connection
 * @param {string} params.inputMint - The mint address of the token being sold
 * @param {string} params.amount - The amount being sold (as a string or number)
 * @param {PublicKey} params.userPublicKey - The user's public key
 * @param {TransactionInstruction[]} params.instructions - Array to add the close instruction to
 * @param {boolean} params.isSellOperation - Whether this is a sell operation
 * @param {number} params.decimals - Number of decimals for the token (optional, will fetch if not provided)
 * @returns {Promise<void>}
 */
export async function addCloseTokenAccountInstructionIfSellAll({
  connection,
  inputMint,
  amount,
  userPublicKey,
  instructions,
  isSellOperation,
  decimals
}: {
  connection: Connection,
  inputMint: string,
  amount: string | number,
  userPublicKey: PublicKey,
  instructions: TransactionInstruction[],
  isSellOperation: boolean,
  decimals?: number
}): Promise<void> {
  // Only proceed if this is a sell operation
  if (!isSellOperation) return;
  
  try {
    // Skip for SOL
    if (inputMint === NATIVE_MINT.toBase58()) return;
    
    const mintPubkey = new PublicKey(inputMint);
    const tokenAta = await getAssociatedTokenAddress(mintPubkey, userPublicKey, false);
    
    // Get the current token balance
    const tokenInfo = await connection.getTokenAccountBalance(tokenAta);
    if (!tokenInfo?.value) {
      console.log('Could not fetch token balance, skipping close account check');
      return;
    }
    
    // Use provided decimals or get from token info
    const tokenDecimals = decimals !== undefined ? decimals : tokenInfo.value.decimals;
    
    // Parse the amount being sold
    const amountNumber = typeof amount === 'string' ? parseFloat(amount) : amount;
    
    // Calculate the raw token amount with the correct decimal precision
    const amountRaw = Math.floor(amountNumber * (10 ** tokenDecimals));
    
    // Get the current balance in raw units
    const balanceRaw = Number(tokenInfo.value.amount);
    
    // Check if selling amount is equal to or greater than balance (accounting for small rounding errors)
    // Using a 0.1% buffer to account for potential rounding issues
    const buffer = balanceRaw * 0.001;
    const isSellAll = amountRaw >= balanceRaw - buffer;
    
    console.log(`Token ${inputMint} - Selling: ${amountRaw}, Balance: ${balanceRaw}, Is sell all: ${isSellAll}`);
    
    if (isSellAll) {
      // IMPORTANT: The close instruction must be executed after the swap
      // to ensure the token account is empty first.
      // We don't need to check if other instructions already closed the account
      // as that would fail with a clear error message.
      console.log(`Adding close account instruction for token ${inputMint} (selling all tokens)`);
      
      // Add the close instruction at the end of the instructions array
      // to ensure it runs after the swap has transferred all tokens
      instructions.push(
        createCloseAccountInstruction(tokenAta, userPublicKey, userPublicKey)
      );
    }
  } catch (error) {
    // Log error but don't fail the entire transaction if this check fails
    console.error('Error in addCloseTokenAccountInstructionIfSellAll:', error);
  }
}

/**
 * Checks if a user's token account is empty and returns a closeAccount instruction if so.
 * Returns undefined if the account is not empty or does not exist.
 *
 * @param connection - Solana connection
 * @param mint - Token mint address
 * @param userPublicKey - User's public key
 * @returns Promise<TransactionInstruction | undefined>
 */
export async function maybeCloseEmptyTokenAccount({
  connection,
  mint,
  userPublicKey
}: {
  connection: Connection,
  mint: PublicKey,
  userPublicKey: PublicKey
}): Promise<TransactionInstruction | undefined> {
  const ata = await getAssociatedTokenAddress(mint, userPublicKey, false);
  const accountInfo = await connection.getTokenAccountBalance(ata).catch(() => undefined);
  if (!accountInfo?.value) return undefined;
  const balance = Number(accountInfo.value.amount);
  if (balance === 0) {
    return createCloseAccountInstruction(ata, userPublicKey, userPublicKey);
  }
  return undefined;
}
