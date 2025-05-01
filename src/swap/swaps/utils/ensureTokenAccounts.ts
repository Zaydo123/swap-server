import {
  PublicKey,
  Connection,
  TransactionInstruction
} from '@solana/web3.js';
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction
} from '@solana/spl-token';

/**
 * Ensures the user has ATAs for all provided mints. Adds create instructions for any missing ATAs.
 * @param connection Solana connection
 * @param userPublicKey The user's public key
 * @param mints Array of token mints to check
 * @param preparatoryInstructions Array to push create instructions into
 */
export async function ensureUserTokenAccounts({
  connection,
  userPublicKey,
  mints,
  preparatoryInstructions
}: {
  connection: Connection,
  userPublicKey: PublicKey,
  mints: PublicKey[],
  preparatoryInstructions: TransactionInstruction[]
}) {
  for (const mint of mints) {
    const ata = getAssociatedTokenAddressSync(mint, userPublicKey);
    const ataInfo = await connection.getAccountInfo(ata);
    if (!ataInfo) {
      preparatoryInstructions.push(
        createAssociatedTokenAccountInstruction(
          userPublicKey,
          ata,
          userPublicKey,
          mint
        )
      );
    }
  }
} 