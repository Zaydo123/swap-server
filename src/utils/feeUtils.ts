import { PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';
import { LAMPORTS_PER_SOL } from '@solana/web3.js';
import { ASTRALANE_TIP_ACCOUNTS } from '../swap/constants';

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

/**
 * Calculates the Astralane tip as a fixed amount (0.001 SOL = 1,000,000 lamports)
 * @returns Tip amount in lamports
 */
export function calculateAstralaneTip(): number {
  return 1_000_000; // 0.001 SOL in lamports
}

/**
 * Returns a SystemProgram.transfer instruction for the Astralane tip.
 * @param from - Tip payer
 * @returns Transfer instruction for the tip
 */
export function makeAstralaneTipInstruction({ from }: { from: PublicKey }): TransactionInstruction {
  const tipAmount = calculateAstralaneTip();
  return SystemProgram.transfer({ 
    fromPubkey: from, 
    toPubkey: ASTRALANE_TIP_ACCOUNTS, 
    lamports: tipAmount 
  });
}
