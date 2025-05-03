import { PublicKey } from '@solana/web3.js';
import { ISwapStrategy } from '../../../../types/ISwapStrategy';
import { TransactionProps } from '../../swap';
import { GenerateInstructionsResult } from '../../types';
import { isLaunchpadDevModeEnabled } from '../../../../../utils/dev-mode';
import { Logger } from '../../../../../utils/logger';

export class DevModeSwapStrategy implements ISwapStrategy {
  private logger = new Logger('DevModeSwapStrategy');

  async canHandle(transactionDetails: TransactionProps): Promise<boolean> {
    const isDevMode = isLaunchpadDevModeEnabled();
    this.logger.log('DevModeSwapStrategy.canHandle', { isDevMode });
    return isDevMode;
  }

  async generateSwapInstructions(
    transactionDetails: TransactionProps
  ): Promise<GenerateInstructionsResult> {
    this.logger.log('DevModeSwapStrategy.generateSwapInstructions', { transactionDetails });

    // In dev mode, we just return an empty result
    // This allows for testing the UI without actually executing any transactions
    return {
      instructions: [],
      signers: [],
      poolAddress: transactionDetails.params.pairAddress 
        ? new PublicKey(transactionDetails.params.pairAddress) 
        : undefined
    };
  }
} 