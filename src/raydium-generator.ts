import {
  LIQUIDITY_STATE_LAYOUT_V4,
  LiquidityPoolKeys,
  SPL_ACCOUNT_LAYOUT,
  TOKEN_PROGRAM_ID,
  TokenAccount,
} from '@raydium-io/raydium-sdk';
import { API_URLS, Raydium } from '@raydium-io/raydium-sdk-v2';
import {
  createInitializeAccountInstruction,
  createSyncNativeInstruction,
  getAssociatedTokenAddress,
  getMinimumBalanceForRentExemptAccount,
  NATIVE_MINT,
} from '@solana/spl-token';
import {
  Connection,
  GetProgramAccountsResponse,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SimulatedTransactionResponse,
  SystemProgram,
  Transaction,
  TransactionConfirmationStrategy,
  VersionedTransaction,
} from '@solana/web3.js';
import { default as bs58 } from 'bs58';
import { sendTransactionWithWSOLFallback } from './swap/utils';

type SwapSide = 'in' | 'out';

export function isBase58(key: string): boolean {
  const trimmed = key.trim();
  if (!trimmed) return false;

  return /^[1-9A-HJ-NP-Za-km-z]+$/.test(trimmed);
}

export function convertBase64ToBase58(base64Key: string): string {
  try {
    let sanitized = base64Key.trim().replace(/-/g, '+').replace(/_/g, '/');

    const padCount = (4 - (sanitized.length % 4)) % 4;
    sanitized += '='.repeat(padCount);

    const binaryString = atob(sanitized);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }

    return bs58.encode(bytes);
  } catch (error) {
    throw new Error(
      `Invalid base64 key: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function importWallet(key: string): Keypair {
  try {
    const cleanedKey = key.trim();
    let base58Key: string;

    if (isBase58(cleanedKey)) {
      base58Key = cleanedKey;
    } else {
      base58Key = convertBase64ToBase58(cleanedKey);
    }

    const decoded = bs58.decode(base58Key);

    if (decoded.length !== 64) {
      throw new Error('Invalid key length. Expected 64 bytes for secret key');
    }

    return Keypair.fromSecretKey(decoded);
  } catch (error) {
    throw new Error(
      `Failed to create wallet: ${error instanceof Error ? error.message : 'Unknown error'}`,
    );
  }
}

export class RaydiumSwap {
  static RAYDIUM_V4_PROGRAM_ID = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';

  connection: Connection;
  wallet: Keypair;
  raydium?: Raydium;

  constructor(RPC_URL: string, WALLET_SECRET_KEY: string) {
    if (!RPC_URL.startsWith('http://') && !RPC_URL.startsWith('https://')) {
      throw new Error('Invalid RPC URL. Must start with http:// or https://');
    }
    this.connection = new Connection(RPC_URL, 'confirmed');

    try {
      if (!WALLET_SECRET_KEY) {
        throw new Error('WALLET_SECRET_KEY is not provided');
      }

      const keypair = importWallet(WALLET_SECRET_KEY);
      this.wallet = keypair as Keypair;
      console.log(
        'Wallet initialized with public key:',
        this.wallet.publicKey.toBase58(),
      );
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Failed to create wallet: ${error.message}`);
      } else {
        throw new Error('Failed to create wallet: Unknown error');
      }
    }
  }

  async getProgramAccounts(
    baseMint: string,
    quoteMint: string,
  ): Promise<GetProgramAccountsResponse> {
    const layout = LIQUIDITY_STATE_LAYOUT_V4;
    return this.connection.getProgramAccounts(
      new PublicKey(RaydiumSwap.RAYDIUM_V4_PROGRAM_ID),
      {
        filters: [
          { dataSize: layout.span },
          {
            memcmp: {
              offset: layout.offsetOf('baseMint'),
              bytes: new PublicKey(baseMint).toBase58(),
            },
          },
          {
            memcmp: {
              offset: layout.offsetOf('quoteMint'),
              bytes: new PublicKey(quoteMint).toBase58(),
            },
          },
        ],
      },
    );
  }

  private async initRaydium() {
    if (!this.raydium) {
      this.raydium = await Raydium.load({
        connection: this.connection,
        cluster: 'mainnet',
        disableFeatureCheck: true,
      });
    }
    return this.raydium;
  }

  async findRaydiumPoolInfo(
    baseMint: string,
    quoteMint: string,
  ): Promise<LiquidityPoolKeys | null> {
    await this.initRaydium();
    const poolInfo = await this.raydium!.api.fetchPoolByMints({
      mint1: baseMint,
      mint2: quoteMint,
    });

    if (!poolInfo?.data?.[0]) return null;

    try {
      const pool = poolInfo.data[0];
      if (!pool.id || !pool.mintA?.address || !pool.mintB?.address) {
        console.log('Invalid pool data:', pool);
        return null;
      }

      // Check if it's a standard pool before accessing lpMint
      const isStandardPool = 'poolType' in pool && pool.poolType === 'Standard';

      // Convert pool info to LiquidityPoolKeys format
      return {
        id: new PublicKey(pool.id),
        baseMint: new PublicKey(pool.mintA.address),
        quoteMint: new PublicKey(pool.mintB.address),
        // Safely access lpMint - only for standard pools (using type assertion)
        lpMint: isStandardPool && (pool as any).lpMint ? new PublicKey((pool as any).lpMint.address) : PublicKey.default,
        baseDecimals: pool.mintA.decimals,
        quoteDecimals: pool.mintB.decimals,
        // Use lpMint decimals if available (standard pools, using type assertion)
        lpDecimals: isStandardPool && (pool as any).lpMint ? (pool as any).lpMint.decimals : 9,
        version: 4,
        programId: new PublicKey(pool.programId),
        authority: PublicKey.default,
        openOrders: PublicKey.default,
        targetOrders: PublicKey.default,
        baseVault: PublicKey.default,
        quoteVault: PublicKey.default,
        withdrawQueue: PublicKey.default,
        lpVault: PublicKey.default,
        marketVersion: 3,
        marketProgramId: PublicKey.default,
        marketId: new PublicKey(pool.id),
        marketAuthority: PublicKey.default,
        marketBaseVault: PublicKey.default,
        marketQuoteVault: PublicKey.default,
        marketBids: PublicKey.default,
        marketAsks: PublicKey.default,
        marketEventQueue: PublicKey.default,
        lookupTableAccount: PublicKey.default,
      } as LiquidityPoolKeys;
    } catch (error) {
      console.error('Error converting pool info:', error);
      return null;
    }
  }

  async getOwnerTokenAccounts() {
    const walletTokenAccount = await this.connection.getTokenAccountsByOwner(
      this.wallet.publicKey,
      {
        programId: TOKEN_PROGRAM_ID,
      },
    );
    return walletTokenAccount.value.map((i) => ({
      pubkey: i.pubkey,
      programId: i.account.owner,
      accountInfo: SPL_ACCOUNT_LAYOUT.decode(i.account.data),
    }));
  }

  private getSwapSide(
    poolKeys: LiquidityPoolKeys,
    wantFrom: PublicKey,
    wantTo: PublicKey,
  ): SwapSide {
    if (
      poolKeys.baseMint.equals(wantFrom) &&
      poolKeys.quoteMint.equals(wantTo)
    ) {
      return 'in';
    } else if (
      poolKeys.baseMint.equals(wantTo) &&
      poolKeys.quoteMint.equals(wantFrom)
    ) {
      return 'out';
    } else {
      throw new Error("Not suitable pool fetched. Can't determine swap side");
    }
  }

  private async getTokenDecimals(mintAddress: string): Promise<number> {
    try {
      const accountInfo = await this.connection.getParsedAccountInfo(
        new PublicKey(mintAddress),
      );

      if (
        !accountInfo.value?.data ||
        typeof accountInfo.value.data !== 'object'
      ) {
        throw new Error('Failed to get account info');
      }

      const parsedData = accountInfo.value.data as {
        parsed: { info: { decimals: number } };
      };
      return parsedData.parsed.info.decimals;
    } catch (error) {
      console.error('Error getting token decimals:', error);
      throw error;
    }
  }

  private logApiRequest(endpoint: string, params: Record<string, any>) {
    const queryString = Object.entries(params)
      .map(([key, value]) => `${key}=${value}`)
      .join('&');
    console.log(`API Request: ${endpoint}?${queryString}`);
    console.log('Parameters:', params);
  }

  async getSwapTransaction(
    toToken: string,
    amount: number,
    slippage: number = 5,
    computeUnitPrice: number = 5,
    isSell: boolean = false
  ): Promise<{ tx: VersionedTransaction; sendyFeeLamports: number }> {
    console.log('Raydium swap - Using computeUnitPrice:', computeUnitPrice, 'micro lamports');
    try {
      const inputMint = isSell ? toToken : NATIVE_MINT.toString();
      const outputMint = isSell ? NATIVE_MINT.toString() : toToken;

      let tokenAccount: string | undefined;
      if (isSell) {
        const ata = await getAssociatedTokenAddress(
          new PublicKey(toToken),
          this.wallet.publicKey,
        );
        tokenAccount = ata.toString();

        const tokenBalance = await this.connection.getTokenAccountBalance(ata);
        console.log('Token balance:', tokenBalance.value);

        if (
          !tokenBalance.value.uiAmount ||
          tokenBalance.value.uiAmount < amount
        ) {
          throw new Error(
            `Insufficient token balance. Have: ${tokenBalance.value.uiAmount}, Need: ${amount}`,
          );
        }
      }

      let amountToUse = isSell
        ? Math.floor(
            amount * Math.pow(10, await this.getTokenDecimals(toToken)),
          )
        : amount;

      const amountInBaseUnits = isSell
        ? amountToUse
        : Math.floor(amount * LAMPORTS_PER_SOL);

      const swapType = 'swap-base-in';

      console.log('Swap params:', {
        inputMint,
        outputMint,
        originalAmount: amount,
        adjustedAmount: amountToUse,
        amountInBaseUnits,
        tokenAccount,
        isSell,
        swapType,
        calculationExplanation: isSell
          ? `Input ${amount} tokens (${amountInBaseUnits} base units)`
          : `Input ${amount} SOL (${amountInBaseUnits} lamports)`,
      });

      const quoteParams = {
        inputMint,
        outputMint,
        amount: amountInBaseUnits,
        slippageBps: slippage * 100,
        txVersion: 'V0',
      };
      this.logApiRequest(
        `${API_URLS.SWAP_HOST}/compute/${swapType}`,
        quoteParams,
      );

      const quoteResponse = await fetch(
        `${API_URLS.SWAP_HOST}/compute/${swapType}?` +
          `inputMint=${inputMint}&` +
          `outputMint=${outputMint}&` +
          `amount=${amountInBaseUnits}&` +
          `slippageBps=${slippage * 100}&` +
          `txVersion=V0`,
      ).then((res) => res.json());

      let sendyFeeLamports: number = 0;
      
      if (!quoteResponse || !quoteResponse.data) {
        console.error('Invalid quote response:', quoteResponse);
        throw new Error('Failed to get valid quote data from Raydium: ' + (quoteResponse?.msg || 'Unknown error'));
      }
      
      if (isSell) {
        if (quoteResponse.data.outputAmount !== undefined && 
            quoteResponse.data.outputAmount !== null) {
          try {
            sendyFeeLamports = Math.floor(
              Number(quoteResponse.data.outputAmount) * 0.01,
            );
            console.log('Sell fee calculation successful:', sendyFeeLamports);
          } catch (error) {
            console.error('Error calculating sell fee:', error);
            sendyFeeLamports = 0;
          }
        } else {
          console.warn('outputAmount is missing from quote response');
          sendyFeeLamports = 0;
        }
      } else {
        if (quoteResponse.data.inputAmount !== undefined && 
            quoteResponse.data.inputAmount !== null) {
          try {
            sendyFeeLamports = Math.floor(
              Number(quoteResponse.data.inputAmount) * 0.01,
            );
            console.log('Buy fee calculation successful:', sendyFeeLamports);
          } catch (error) {
            console.error('Error calculating buy fee:', error);
            sendyFeeLamports = 0;
          }
        } else {
          console.warn('inputAmount is missing from quote response');
          sendyFeeLamports = 0;
        }
      }

      if (!Number.isInteger(sendyFeeLamports)) {
        sendyFeeLamports = Math.floor(sendyFeeLamports);
      }

      console.log('Fee calculation:', {
        amount: quoteResponse.data.outputAmount,
        fee: sendyFeeLamports,
        calculation: `${quoteResponse.data.outputAmount} * 0.01 = ${sendyFeeLamports}`,
      });

      console.log('Quote Response:', quoteResponse);

      if (!quoteResponse.success) {
        throw new Error('Failed to get quote: ' + quoteResponse.msg);
      }

      const initialTxParams = {
        computeUnitPriceMicroLamports: "1",
        swapResponse: quoteResponse,
        txVersion: 'V0',
        wallet: this.wallet.publicKey.toString(),
        wrapSol: !isSell,
        unwrapSol: isSell,
        inputAccount: tokenAccount,
      };

      console.log('Initial transaction for simulation:', initialTxParams);
      
      const simTxResponse = await fetch(
        `${API_URLS.SWAP_HOST}/transaction/${swapType}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(initialTxParams),
        },
      ).then((res) => res.json());

      if (!simTxResponse.success) {
        throw new Error('Failed to get transaction for simulation: ' + simTxResponse.msg);
      }

      const simTx = VersionedTransaction.deserialize(
        Buffer.from(simTxResponse.data[0].transaction, 'base64'),
      );

      console.log('Simulating Raydium transaction to determine compute units...');
      
      const simulateConfig = {
        sigVerify: false,
        replaceRecentBlockhash: true,
        commitment: 'confirmed' as const,
      };
      
      const DEFAULT_COMPUTE_UNITS = 250000;
      let actualComputeUnits = DEFAULT_COMPUTE_UNITS;
      
      try {
        const simulationResponse = await this.connection.simulateTransaction(simTx, simulateConfig);
        
        if (simulationResponse?.value?.logs) {
          console.log('Raydium simulation logs:', simulationResponse.value.logs);
          
          const cuRegex = /consumed (\d+) of \d+ compute units/;
          for (const log of simulationResponse.value.logs) {
            const match = log.match(cuRegex);
            if (match && match[1]) {
              actualComputeUnits = parseInt(match[1], 10);
              console.log(`Found Raydium actual compute units used: ${actualComputeUnits}`);
              break;
            }
          }
        }
        
        if (simulationResponse?.value?.unitsConsumed) {
          actualComputeUnits = simulationResponse.value.unitsConsumed;
          console.log(`Using Raydium unitsConsumed from simulation: ${actualComputeUnits}`);
        }
      } catch (error) {
        console.error('Raydium transaction simulation failed:', error);
        console.log('Using default compute units estimate:', DEFAULT_COMPUTE_UNITS);
      }

      const adjustedComputeUnits = Math.ceil(actualComputeUnits * 1.2);
      console.log(`Using Raydium compute units: ${adjustedComputeUnits} (actual: ${actualComputeUnits} + 20% buffer)`);

      let microLampertsPerCU: number = computeUnitPrice;
      
      if (microLampertsPerCU <= 0) {
        microLampertsPerCU = 1;
        console.warn('Corrected zero micro lamports to minimum value of 1');
      }
      
      const estimatedTotalPriorityFee = (microLampertsPerCU * adjustedComputeUnits) / 1_000_000;
      
      console.log(`RAYDIUM PRIORITY FEE: ${microLampertsPerCU} microlamports/CU, total ~${estimatedTotalPriorityFee.toFixed(9)} SOL`);
      console.log(`Expected base network fee: ~0.000005 SOL + priority fee: ~${estimatedTotalPriorityFee.toFixed(9)} SOL`);
      
      const txParams = {
        computeUnitPriceMicroLamports: String(microLampertsPerCU),
        swapResponse: quoteResponse,
        txVersion: 'V0',
        wallet: this.wallet.publicKey.toString(),
        wrapSol: !isSell,
        unwrapSol: isSell,
        inputAccount: tokenAccount,
      };

      console.log('Final Transaction Request:', txParams);

      const txResponse = await fetch(
        `${API_URLS.SWAP_HOST}/transaction/${swapType}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(txParams),
        },
      ).then((res) => res.json());

      if (!txResponse.success) {
        throw new Error('Failed to get transaction: ' + txResponse.msg);
      }

      return {
        tx: VersionedTransaction.deserialize(
          Buffer.from(txResponse.data[0].transaction, 'base64'),
        ),
        sendyFeeLamports,
      };
    } catch (error) {
      console.error('Error in getSwapTransaction:', error);
      throw new Error(`Failed to get valid quote data from Raydium: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async sendLegacyTransaction(tx: Transaction): Promise<string> {
    try {
      const signature = await sendTransactionWithWSOLFallback(
        this.connection,
        tx,
        this.wallet,
        {
          skipPreflight: true,
          preflightCommitment: 'confirmed',
        }
      );
      console.log('Legacy transaction sent, signature:', signature);
      
      const latestBlockhash = await this.connection.getLatestBlockhash();
      const confirmationStrategy: TransactionConfirmationStrategy = {
        signature: signature,
        blockhash: latestBlockhash.blockhash,
        lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
      };
      const confirmation = await this.connection.confirmTransaction(
        confirmationStrategy,
        'confirmed',
      );
      if (confirmation.value.err) {
        throw new Error(
          `Transaction failed: ${confirmation.value.err.toString()}`,
        );
      }
      return signature;
    } catch (error) {
      console.error('Error sending legacy transaction:', error);
      throw error;
    }
  }

  async sendVersionedTransaction(
    tx: VersionedTransaction,
    blockhash: string,
    lastValidBlockHeight: number,
  ): Promise<string> {
    try {
      const signature = await sendTransactionWithWSOLFallback(
        this.connection,
        tx,
        this.wallet,
        {
          skipPreflight: true,
          preflightCommitment: 'confirmed',
        }
      );
      console.log('Versioned transaction sent, signature:', signature);

      const confirmationStrategy: TransactionConfirmationStrategy = {
        signature: signature,
        blockhash: blockhash,
        lastValidBlockHeight: lastValidBlockHeight,
      };

      const confirmation = await this.connection.confirmTransaction(
        confirmationStrategy,
        'confirmed',
      );
      if (confirmation.value.err) {
        throw new Error(
          `Transaction failed: ${confirmation.value.err.toString()}`,
        );
      }
      return signature;
    } catch (error) {
      console.error('Error sending versioned transaction:', error);
      throw error;
    }
  }

  async simulateLegacyTransaction(
    tx: Transaction,
  ): Promise<SimulatedTransactionResponse> {
    const { value } = await this.connection.simulateTransaction(tx);
    return value;
  }

  async simulateVersionedTransaction(
    tx: VersionedTransaction,
  ): Promise<SimulatedTransactionResponse> {
    const { value } = await this.connection.simulateTransaction(tx);
    return value;
  }

  getTokenAccountByOwnerAndMint(mint: PublicKey) {
    return {
      programId: TOKEN_PROGRAM_ID,
      pubkey: PublicKey.default,
      accountInfo: {
        mint: mint,
        amount: 0,
      },
    } as unknown as TokenAccount;
  }

  async createWrappedSolAccountInstruction(amount: number): Promise<{
    transaction: Transaction;
    wrappedSolAccount: Keypair;
  }> {
    const lamports = amount * LAMPORTS_PER_SOL;
    const wrappedSolAccount = Keypair.generate();
    const transaction = new Transaction();

    const rentExemptBalance = await getMinimumBalanceForRentExemptAccount(
      this.connection,
    );

    transaction.add(
      SystemProgram.createAccount({
        fromPubkey: this.wallet.publicKey,
        newAccountPubkey: wrappedSolAccount.publicKey,
        lamports: rentExemptBalance,
        space: 165,
        programId: TOKEN_PROGRAM_ID,
      }),
      createInitializeAccountInstruction(
        wrappedSolAccount.publicKey,
        NATIVE_MINT,
        this.wallet.publicKey,
      ),
      SystemProgram.transfer({
        fromPubkey: this.wallet.publicKey,
        toPubkey: wrappedSolAccount.publicKey,
        lamports,
      }),
      createSyncNativeInstruction(wrappedSolAccount.publicKey),
    );

    return { transaction, wrappedSolAccount };
  }
}
 