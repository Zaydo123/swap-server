import {
  ComputeBudgetProgram,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
} from '@solana/web3.js';

export const PRIORITY_RATE = 100; // MICRO_LAMPORTS
export const SEND_AMT = 0.01 * LAMPORTS_PER_SOL;
export const PRIORITY_FEE_IX = ComputeBudgetProgram.setComputeUnitPrice({
  microLamports: PRIORITY_RATE,
});
export const GLOBAL = new PublicKey(
  '4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf',
); // global pump.fun account
export const FEE_RECIPIENT = new PublicKey(
  'CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM',
); // pump.fun fee recipient
export const TOKEN_PROGRAM_ID = new PublicKey(
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
); // Token Program ID
export const ASSOC_TOKEN_ACC_PROG = new PublicKey(
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
); // Associated Token Account Program
export const RENT = new PublicKey(
  'SysvarRent111111111111111111111111111111111',
); // Rent Program
export const PUMP_FUN_PROGRAM = new PublicKey(
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
); // pump.fun program
export const PUMP_FUN_ACCOUNT = new PublicKey(
  'Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1',
); // eventAuthority
export const MOONSHOT_PROGRAM = new PublicKey(
  'MoonCVVNZFSYkqNXP6bxHLPL6QQJiMagDL3qcqUQTrG',
); // moon shot program
export const RAYDIUM_LIQUIDITY_POOL_V4 = new PublicKey(
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
); // raydium liquidity pool v4
export const SYSTEM_PROGRAM_ID = SystemProgram.programId;
export const JITO_TIP_ACCOUNTS = [
  'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
  'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
  'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
  'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
  'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
  'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
  '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
];
export const SENDY_FEE_ACCOUNT = new PublicKey(
  'SENDYqY3MviDCZbygkpmgKX7T4EAk3TwkDNb1GGu7tD',
); // sendy fee account 
export const LAUNCHPAD_PROGRAM = new PublicKey(
  'LanMkFSVSncjWqWAM8MUHenZzt9xTcT3DcAp949ZwbF'
); 
