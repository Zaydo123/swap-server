import { Connection, PublicKey, TransactionInstruction, AddressLookupTableAccount, VersionedTransaction } from '@solana/web3.js';

// Single source of truth for transaction parameters
export interface TransactionProps {
    params: {
        // Use input/output mints for clarity with SDKs
        inputMint: string;      // Mint address of the token being sent
        outputMint: string;     // Mint address of the token being received
        amount: string;         // Amount IN LAMPORTs (string for large numbers) of the inputMint token
        slippageBps: number;    // Slippage tolerance in basis points (e.g., 50 for 0.5%)
        userWalletAddress: string; // User's public key address
        type: 'buy' | 'sell';   // Swap type (may influence which mint is 'amount' source)
        priorityFee?: number;   // Optional priority fee in micro-lamports
    };
}

export interface SwapStrategyDependencies {
  connection: Connection;
  rpcUrl: string;
  // Add other dependencies needed by strategies, e.g., Moonshot instance
}

export interface GenerateInstructionsResult {
  /** Indicates whether instruction generation was successful. */
  success: boolean;
  /** Error message if generation failed. */
  error?: string;
  /** Transaction instructions that will perform the swap */
  instructions?: TransactionInstruction[];
  /** Optional instructions to be added *after* main swap instructions, e.g., closing temporary accounts. */
  cleanupInstructions?: TransactionInstruction[];
  /** The calculated Sendy fee for this specific swap strategy, if applicable. */
  sendyFeeLamports?: number | string | bigint;
  /** The address of the primary pool or curve being interacted with. */
  poolAddress?: PublicKey;
  addressLookupTables?: AddressLookupTableAccount[];
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