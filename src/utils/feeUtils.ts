import { PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';
import { LAMPORTS_PER_SOL } from '@solana/web3.js';

/**
 * Calculates the Sendy fee as a simple 1% of SOL amount
 * @param solAmount - The SOL amount in lamports
 * @returns Fee amount in lamports
 */
export function calculateSendyFee(solAmount: bigint): bigint {
  // Simple 1% fee
  return solAmount / 100n;
}

/**
 * Returns a SystemProgram.transfer instruction for the Sendy fee if lamports > 0, else undefined.
 * @param from - Fee payer
 * @param to - Fee recipient
 * @param lamports - Amount to transfer
 */
export function makeSendyFeeInstruction({ from, to, lamports }:{ from: PublicKey, to: PublicKey, lamports: number }): TransactionInstruction | undefined {
  if (lamports > 0) {
    return SystemProgram.transfer({ fromPubkey: from, toPubkey: to, lamports });
  }
  return undefined;
}
