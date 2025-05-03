import { Connection, PublicKey, LAMPORTS_PER_SOL, VersionedTransaction } from '@solana/web3.js';
import { Request, Response } from 'express';
import { TransactionProps, ISwapStrategy, SwapStrategyDependencies, GenerateInstructionsResult } from './swaps/base/ISwapStrategy';
import { getSwapStrategy } from './swaps/router';
import { generateAndCompileTransaction } from './swap';
import dotenv from 'dotenv';

dotenv.config();

// --- Constants & Config --- 
const RPC_URL = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";

export async function handleSwapRequest(req: Request, res: Response): Promise<void> {
    console.log('Received swap request:', req.body);

    // Access request body correctly - assuming params are directly in body or nested
    // Adjust this based on actual request structure if needed
    const paramsFromBody = req.body.params || req.body; // Adapt as necessary
    
    // Validate essential params exist before creating TransactionProps
    if (!paramsFromBody || typeof paramsFromBody.userWalletAddress !== 'string') {
        console.error('Invalid swap request: userWalletAddress is missing or invalid.');
        res.status(400).json({ success: false, error: 'Invalid request: userWalletAddress missing or invalid.' });
        return;
    }
    if (typeof paramsFromBody.inputMint !== 'string' || typeof paramsFromBody.outputMint !== 'string') {
        console.error('Invalid swap request: inputMint or outputMint is missing or invalid.');
        res.status(400).json({ success: false, error: 'Invalid request: inputMint or outputMint missing or invalid.' });
        return;
    }
    if (typeof paramsFromBody.amount !== 'string') { // Ensure amount is string
         console.error('Invalid swap request: amount is missing or not a string.');
         res.status(400).json({ success: false, error: 'Invalid request: amount missing or not a string.' });
         return;
    }
     if (typeof paramsFromBody.slippageBps !== 'number') {
         console.error('Invalid swap request: slippageBps is missing or not a number.');
         res.status(400).json({ success: false, error: 'Invalid request: slippageBps missing or not a number.' });
         return;
    }
    if (typeof paramsFromBody.type !== 'string' || (paramsFromBody.type !== 'buy' && paramsFromBody.type !== 'sell')) {
        console.error('Invalid swap request: type is missing or invalid.');
        res.status(400).json({ success: false, error: 'Invalid request: type missing or invalid.' });
        return;
    }

    // Construct the full TransactionProps object
    const transactionDetails: TransactionProps = {
        params: {
            inputMint: paramsFromBody.inputMint,
            outputMint: paramsFromBody.outputMint,
            amount: paramsFromBody.amount, // Already validated as string
            slippageBps: paramsFromBody.slippageBps, // Already validated as number
            userWalletAddress: paramsFromBody.userWalletAddress, // Already validated as string
            type: paramsFromBody.type, // Already validated
            priorityFee: typeof paramsFromBody.priorityFee === 'number' ? paramsFromBody.priorityFee : undefined // Optional
        }
    };

    // --- Validate Request --- 
    // Temporarily disable validation until path is fixed
    // const validationError = validateTransactionProps(transactionDetails); 
    // if (validationError) {
    //     console.error(`Invalid swap request: ${validationError}`);
    //     res.status(400).json({ success: false, error: validationError });
    //     return;
    // }

    // --- Setup Dependencies --- 
    const connection = new Connection(RPC_URL, 'confirmed');

    const strategyDeps: SwapStrategyDependencies = {
        connection,
        rpcUrl: RPC_URL,
    };

    // --- Select Strategy --- 
    let selectedStrategy: ISwapStrategy;
    try {
        selectedStrategy = await getSwapStrategy(transactionDetails, strategyDeps);
        console.log(`Selected strategy: ${selectedStrategy.constructor.name}`);
    } catch (err) {
        console.error('No suitable swap strategy found for the request.', err);
        res.status(400).json({ success: false, error: 'No suitable swap strategy found.' });
        return;
    }

    try {
        // --- Get Blockhash --- 
        const { blockhash: recentBlockhash } = await connection.getLatestBlockhash();

        // --- Generate Instructions using Strategy --- 
        const instructionResult: GenerateInstructionsResult = await selectedStrategy.generateSwapInstructions(transactionDetails, strategyDeps);

        if (!instructionResult.success) {
              console.error(`Strategy failed to generate instructions: ${instructionResult.error}`); 
              res.status(400).json({ success: false, error: instructionResult.error || 'Strategy failed to generate instructions' });
        } else {
            if (!instructionResult.instructions || instructionResult.instructions.length === 0) {
                console.error('Strategy succeeded but returned no instructions.');
                res.status(500).json({ success: false, error: 'Internal server error: Invalid strategy result (no instructions).' });
                return;
            }
            
            // --- Compile Transaction with Instructions from Strategy --- 
            const userPublicKey = new PublicKey(transactionDetails.params.userWalletAddress); // Use validated param
            // Use default fee or fee from strategy result
            const feeLamports = instructionResult.sendyFeeLamports ? Number(instructionResult.sendyFeeLamports) : (0.00005 * LAMPORTS_PER_SOL); // Fix Number() call
            const priorityFeeMicroLamports = transactionDetails.params.priorityFee ? transactionDetails.params.priorityFee * 1_000_000 : 0; // Convert SOL to micro-lamports if priorityFee is in SOL, adjust if it's already micro-lamports

            const compiledResult = await generateAndCompileTransaction(
                userPublicKey,
                instructionResult.instructions, 
                instructionResult.addressLookupTables || [], 
                recentBlockhash,
                priorityFeeMicroLamports, // Value is already in microLamports, do not convert again
                feeLamports
            );

            if (!compiledResult.success || compiledResult.transactions.length === 0) {
                console.error(`Transaction compilation failed: ${compiledResult.error}`); 
                res.status(500).json({ success: false, error: compiledResult.error || 'Failed to compile transaction' });
            } else {
                const serializedTransactions = compiledResult.transactions.map(tx => Buffer.from(tx.serialize()).toString('base64'));
                console.log('Successfully generated and compiled swap transaction(s).'); 
                res.status(200).json({
                    success: true,
                    message: 'Swap transaction(s) generated successfully.',
                    transactions: serializedTransactions, // Now always an array
                    poolAddress: instructionResult.poolAddress?.toBase58() 
                });
            }
        }
    } catch (error: any) {
        console.error(`Error handling swap request: ${error.message}`, { stack: error.stack }); 
        res.status(500).json({ success: false, error: `Failed to process swap: ${error.message}` });
    }
}