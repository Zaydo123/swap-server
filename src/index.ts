import express, { Request, Response } from 'express';
import { Connection } from '@solana/web3.js';
import { buildUnsignedSwapTransaction, UnsignedTransactionProps } from './swap/entrypoint';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

app.post('/swap', async (req: Request, res: Response) => {
  try {
    const { transactionDetails, rpcUrl } = req.body;

    if (!transactionDetails || !transactionDetails.params || !rpcUrl) {
      res.status(400).json({
        success: false,
        error: 'Missing required fields: transactionDetails.params and rpcUrl are required.'
      });
      return;
    }

    // Prepare connection
    const connection = new Connection(rpcUrl, 'confirmed');

    // Build unsigned swap transaction (no secret required)
    const result = await buildUnsignedSwapTransaction(
      transactionDetails as UnsignedTransactionProps,
      rpcUrl,
      connection
    );

    res.json({
      ...result,
      success: true,
      error: null
    });
  } catch (error) {
    console.error('Swap error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : String(error)
    });
  }
});

app.get('/', (_req: Request, res: Response) => {
  res.send('Solana Swap Server is running!');
});

app.get('/docs', (_req: Request, res: Response) => {
  res.json({
    openapi: '3.0.0',
    info: {
      title: 'Solana Swap Server API',
      version: '1.0.0',
      description: 'API for generating unsigned Solana swap instructions/transactions.'
    },
    paths: {
      '/swap': {
        post: {
          summary: 'Generate unsigned swap instructions/transaction',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    transactionDetails: {
                      type: 'object',
                      properties: {
                        params: {
                          type: 'object',
                          properties: {
                            pairAddress: { type: 'string', description: 'Pool/pair address (required)' },
                            mintAddress: { type: 'string', description: 'Token mint address (required)' },
                            targetMint: { type: 'string', description: 'Optional: target mint for swaps' },
                            baseMint: { type: 'string', description: 'Optional: base mint for swaps' },
                            type: { type: 'string', enum: ['buy', 'sell'], description: 'Swap type (required)' },
                            amount: { type: 'number', description: 'Amount to swap (required)' },
                            amountIsInSol: { type: 'boolean', description: 'Is the amount in SOL? (required)' },
                            userWalletAddress: { type: 'string', description: 'User wallet address (required)' },
                            briberyAmount: { type: 'number', description: 'Optional: Jito tip' },
                            priorityFee: { type: 'number', description: 'Optional: priority fee in SOL' },
                            slippage: { type: 'number', description: 'Slippage tolerance (required)' },
                            computeUnitPrice: { type: 'number', description: 'Optional: calculated if priorityFee is given' },
                            devMode: { type: 'boolean', description: 'Optional: dev mode flag' }
                          },
                          required: ['pairAddress', 'mintAddress', 'type', 'amount', 'amountIsInSol', 'userWalletAddress', 'slippage']
                        }
                      },
                      required: ['params']
                    },
                    rpcUrl: { type: 'string', description: 'The Solana RPC endpoint to use (required)' }
                  },
                  required: ['transactionDetails', 'rpcUrl']
                }
              }
            }
          },
          responses: {
            '200': {
              description: 'Unsigned transactions or error',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      success: { type: 'boolean' },
                      transactions: { type: 'array', items: { type: 'string', description: 'Base64-encoded unsigned transaction' } },
                      txCount: { type: 'integer', description: 'Number of transactions to sign and send' },
                      swapInstructions: { type: 'array', items: { type: 'object' } },
                      cleanupInstructions: { type: 'array', items: { type: 'object' } },
                      feeAmountLamports: { type: 'string' },
                      poolAddress: { type: 'string' },
                      error: { type: 'string', nullable: true }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  });
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
}); 