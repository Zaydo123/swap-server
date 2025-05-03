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
      instructions.push(SystemProgram.transfer({
        fromPubkey: userPublicKey,
        toPubkey: wsolAta,
        lamports: Number(wsolHandling.amount),
      }));
    }
  }
  if (wsolHandling && wsolHandling.unwrap) {
    const wsolAta = await getAssociatedTokenAddress(NATIVE_MINT, userPublicKey, false);
    instructions.push(createCloseAccountInstruction(wsolAta, userPublicKey, userPublicKey));
  }
  return { ataMap };
}

// Utility: Add WSOL unwrap (close account) instruction if outputMint is WSOL
export async function addWsolUnwrapInstructionIfNeeded({
  outputMint,
  userPublicKey,
  instructions
}: {
  outputMint: string,
  userPublicKey: PublicKey,
  instructions: TransactionInstruction[]
}) {
  if (outputMint === NATIVE_MINT.toBase58()) {
    const wsolAta = await getAssociatedTokenAddress(NATIVE_MINT, userPublicKey, false);
    instructions.push(
      createCloseAccountInstruction(wsolAta, userPublicKey, userPublicKey)
    );
  }
}
