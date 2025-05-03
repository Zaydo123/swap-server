import { PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';

/**
 * Calculates the Sendy fee as a percentage (basis points) of the given lamport amount.
 * @param amountLamports - The base amount in lamports
 * @param feeBps - The fee in basis points (e.g. 100 = 1%)
 * @returns bigint fee amount
 */
export function calculateSendyFee({ amountLamports, feeBps = 100 }:{ amountLamports: bigint, feeBps?: number }): bigint {
  return (amountLamports * BigInt(feeBps)) / 10000n;
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
