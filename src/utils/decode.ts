import { Buffer } from 'buffer';
import { Keypair } from '@solana/web3.js';

export function decodeSecretKey(encodedKey: string): Uint8Array {
  return Buffer.from(encodedKey, 'base64');
}

export function createKeypairFromSecretKey(encodedKey: string): Keypair {
  const secretKey = decodeSecretKey(encodedKey);
  return Keypair.fromSecretKey(secretKey);
} 