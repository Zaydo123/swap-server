# Solana Swap Server

A TypeScript/Node.js backend for generating unsigned Solana swap transactions and instructions for various swap strategies (Raydium, Pump.fun, Moonshot, and more).

**Note:**  
A 1% fee is included in every swap and sent to our designated fee account.

---

## Features

- Supports multiple swap strategies (Raydium, Pump.fun Bonding Curve, Moonshot, etc.)
- Returns unsigned Solana transactions for client-side signing
- Caching via Redis for performance
- Built-in 1% fee to our account on every swap
- **Handles account closures and WSOL unwrapping automatically when needed**

---

## Limitations & Warnings

- **Public Solana RPC endpoints (like `api.mainnet-beta.solana.com`) will NOT work due to API limitations.**
  - You must use a private or dedicated Solana RPC provider (e.g. Helius, Triton, QuickNode, etc.).
- **Swaps between tokens (e.g. BONK for RAY) are not fully tested or implemented yet.**
  - Most testing has been done for SOL <-> token swaps.

---

## Requirements

- Node.js (22+ recommended)
- Yarn
- Access to a Solana RPC endpoint
- Redis server (for caching, optional but recommended)

---

## Environment Variables

Create a `.env` file in the `swap-server/` directory with the following variables:

```env
# Solana RPC endpoint (required)
RPC_URL=https://rpc-endpoint.com

# Redis connection string (optional, defaults to redis://127.0.0.1:6379)
REDIS_URL=redis://127.0.0.1:6379

# Disable Redis cache (optional, set to 'true' to disable)
NO_CACHE=false

# Port to run the server on (optional, defaults to 3000)
PORT=3000
```

---

## Installation

```bash
cd swap-server
yarn install
```

---

## Build & Run

```bash
yarn build && yarn start
```

The server will start on the port specified in your `.env` (default: 3000).

---

## API Usage

> **Important:**  
> In some edge cases, the API may return **multiple transactions**.  
> **You must execute/sign ALL returned transactions in order, or the swap will not complete.**  
> This can happen for account closures, WSOL unwrapping, or complex swaps.

- **POST /swap**  
  Generate unsigned swap instructions/transactions.

  Example request body:
  ```json
  {
    "transactionDetails": {
      "params": {
        "inputMint": "So11111111111111111111111111111111111111112",
        "outputMint": "<TOKEN_MINT>",
        "amount": "0.01",
        "slippageBps": 500,
        "userWalletAddress": "<YOUR_WALLET_ADDRESS>",
        "type": "buy",
        "priorityFee": 0.0005
      }
    },
    "rpcUrl": "https://rpc-endpoint.com"
  }
  ```

- **GET /**  
  Health check endpoint.

- **GET /docs**  
  Returns OpenAPI-style documentation for the API.

---

## Fee Notice

> **All swaps include a 1% fee, which is automatically sent to our designated fee account.**

---

## License

MIT 