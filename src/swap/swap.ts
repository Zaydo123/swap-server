// Cleaned up swap.ts for Node.js environment
import {
  AccountLayout,
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
  createCloseAccountInstruction,
} from '@solana/spl-token';
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  AddressLookupTableAccount,
} from '@solana/web3.js';
import * as CNST from './constants';
import { ISwapStrategy, GenerateInstructionsResult, SwapStrategyDependencies } from './swaps/base/ISwapStrategy'; // Import strategy base

// Define the expected return structure for entrypoint
interface ConsolidatedSwapResult {
    success: boolean;
    error?: string;
    transactions: VersionedTransaction[]; // Should be single transaction
    txCount: number;
}

// --- Transaction Builder Utility ---
// This function MUST bundle all swap-related actions (ATA creation, compute budget, fee transfer, swap) into a single transaction.
// All strategies MUST return every instruction needed for the swap (including ATAs, compute, fees) in their instructions array.
// No setup or side-effect instructions should be sent outside this transaction.
//
// Instruction ordering:
//   1. Compute budget (if not already included)
//   2. All preparatory/setup instructions (e.g., ATA creation)
//   3. Fee transfer instructions (if any)
//   4. Swap instruction(s)
//
// This function will concatenate all instructions and return a single VersionedTransaction.
export async function generateAndCompileTransaction(
  userPublicKey: PublicKey, // Passed explicitly
  swapInstructions: TransactionInstruction[], // Should include ALL setup and swap instructions
  lookupTables: AddressLookupTableAccount[] = [], // Passed from strategy result
  recentBlockhash: string,
  priorityFee: number = 0, // Passed explicitly
  feeLamports: number = 0 // Passed explicitly (Sendy Fee)
): Promise<ConsolidatedSwapResult> {

  let allInstructions: TransactionInstruction[] = [];

  // --- 1. Compute Budget Instructions (Add if needed) --- //
  // If strategy did not include compute budget, add it here
  if (priorityFee > 0) {
    const microLamports = Math.ceil(priorityFee * 1_000_000);
    if (microLamports > 0) {
        console.log(`Prepending compute unit price IX: ${microLamports} microLamports`);
        allInstructions.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports }));
    } else {
        console.log('Skipping compute budget price (priorityFee too low)');
    }
  } else {
      console.log('Skipping compute budget instructions (priorityFee <= 0)');
  }

  // --- 2. Append all strategy-provided instructions --- //
  // These should include: ATA creation, fee transfer, swap instructions
  allInstructions.push(...swapInstructions);

  // --- 3. Compile and return single VersionedTransaction --- //
  try {
    const finalMessage = new TransactionMessage({
      payerKey: userPublicKey,
      recentBlockhash,
      instructions: allInstructions,
    }).compileToV0Message(lookupTables.length > 0 ? lookupTables : undefined);

    const finalTransaction = new VersionedTransaction(finalMessage);
    console.log('Successfully compiled final VersionedTransaction.');

    return {
      success: true,
      transactions: [finalTransaction],
      txCount: 1,
    };
  } catch (compileError: any) {
      console.error('Error compiling final transaction:', compileError);
      return { success: false, error: `Transaction compilation error: ${compileError.message || String(compileError)}`, transactions: [], txCount: 0 };
  }
}