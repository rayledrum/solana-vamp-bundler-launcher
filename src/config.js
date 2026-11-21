require('dotenv').config();
const { PublicKey } = require('@solana/web3.js');

module.exports = {
  PORT: process.env.PORT || 3000,
  HOST: process.env.HOST || '0.0.0.0',

  // Helius RPC (Free Tier)
  HELIUS_API_KEY: process.env.HELIUS_API_KEY || '220f30dc-604f-49f0-8503-2f342d96b921',
  HELIUS_RPC_URL: process.env.HELIUS_RPC_URL || `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY || '220f30dc-604f-49f0-8503-2f342d96b921'}`,
  HELIUS_WS_URL: process.env.HELIUS_WS_URL || `wss://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY || '220f30dc-604f-49f0-8503-2f342d96b921'}`,
  SOLANA_PUBLIC_RPC_URL: process.env.SOLANA_PUBLIC_RPC_URL || 'https://api.mainnet.solana.com',

  // Jito Block Engine
  JITO_BLOCK_ENGINE_URL: process.env.JITO_BLOCK_ENGINE_URL || 'https://mainnet.block-engine.jito.wtf/api/v1/bundles',
  JITO_ENDPOINTS: [
    'https://mainnet.block-engine.jito.wtf/api/v1/bundles',
    'https://amsterdam.mainnet.block-engine.jito.wtf/api/v1/bundles',
    'https://frankfurt.mainnet.block-engine.jito.wtf/api/v1/bundles',
    'https://ny.mainnet.block-engine.jito.wtf/api/v1/bundles',
    'https://tokyo.mainnet.block-engine.jito.wtf/api/v1/bundles'
  ],
  DEFAULT_JITO_TIP: parseFloat(process.env.DEFAULT_JITO_TIP || '0.003'),

  // Official Jito Tip Accounts
  JITO_TIP_ACCOUNTS: [
    '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
    'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
    'Cw8CFyM9FkoMi7K7CrnxHyGiYfqEiMg74z1jWM98AZeS',
    'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
    'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
    'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
    'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
    '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT'
  ],

  // Pump.fun Protocol Addresses
  PUMP_PROGRAM_ID: new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'),
  PUMP_FEE_RECIPIENT: new PublicKey('CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM'),
  PUMP_GLOBAL: new PublicKey('4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf'),
  PUMP_EVENT_AUTHORITY: new PublicKey('Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1'),
  SYSTEM_PROGRAM_ID: new PublicKey('11111111111111111111111111111111'),
  TOKEN_PROGRAM_ID: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
  ASSOC_TOKEN_ACC_PROG_ID: new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'),
  RENT_SYSVAR: new PublicKey('SysvarRent111111111111111111111111111111111'),

  // Free APIs
  DEXSCREENER_API: 'https://api.dexscreener.com/latest/dex',
  PUMPPORTAL_API: 'https://pumpportal.fun/api',
  PUMPPORTAL_WS: 'wss://pumpportal.fun/api/data',

  // Mode: can be toggled via API/UI
  SIMULATION_MODE: process.env.SIMULATION_MODE === 'true'
};

