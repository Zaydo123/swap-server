import { Connection, PublicKey, TransactionInstruction, Keypair } from '@solana/web3.js';
import { TransactionProps } from '../../swap'; // Adjust path if needed

export interface SwapStrategyDependencies {
  connection: Connection;
  heliusRpcUrl: string;
  wallet: Keypair;
  // Add other dependencies needed by strategies, e.g., Moonshot instance
}

export interface GenerateInstructionsResult {
  /** Transaction instructions that will perform the swap */
  instructions: TransactionInstruction[];
  /** Optional instructions to be added *after* main swap instructions, e.g., closing temporary accounts. */
  cleanupInstructions?: TransactionInstruction[];
  /** The calculated Sendy fee for this specific swap strategy, if applicable. */
  sendyFeeLamports?: bigint;
  /** The address of the primary pool or curve being interacted with. */
  poolAddress?: PublicKey;
}

export interface ISwapStrategy {
  /**
   * Determines if this strategy is applicable for the given transaction details.
   * @param transactionDetails The details of the swap.
   * @param dependencies Shared dependencies like connection.
   * @returns True if the strategy can handle this swap, false otherwise.
   */
  canHandle(
    transactionDetails: TransactionProps,
    dependencies: SwapStrategyDependencies
  ): Promise<boolean>;

  /**
   * Generates the core transaction instructions for the swap.
   * @param transactionDetails The details of the swap.
   * @param dependencies Shared dependencies like connection.
   * @returns An object containing the instructions and potentially a fee amount.
   */
  generateSwapInstructions(
    transactionDetails: TransactionProps,
    dependencies: SwapStrategyDependencies
  ): Promise<GenerateInstructionsResult>;
} 