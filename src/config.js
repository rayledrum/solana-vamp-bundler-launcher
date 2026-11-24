require('dotenv').config();
const { PublicKey } = require('@solana/web3.js');

function envFlag(name) {
  return String(process.env[name] || '').trim().toLowerCase() === 'true';
}

function num(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`Environment variable ${name} must be a finite number`);
  }
  return value;
}

// Live trading is off unless LIVE_TRADING=true. SIMULATION_MODE=false must not
// turn live mode on; that string used to be treated as truthy by Boolean().
const LIVE_TRADING = envFlag('LIVE_TRADING');
const HELIUS_API_KEY = String(process.env.HELIUS_API_KEY || '').trim();
const HELIUS_RPC_URL = String(process.env.HELIUS_RPC_URL || '').trim()
  || (HELIUS_API_KEY ? `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}` : '');
const HELIUS_WS_URL = String(process.env.HELIUS_WS_URL || '').trim()
  || (HELIUS_API_KEY ? `wss://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}` : '');

if (LIVE_TRADING && !HELIUS_RPC_URL) {
  throw new Error(
    'LIVE_TRADING=true but no RPC is configured. Set HELIUS_RPC_URL or HELIUS_API_KEY in .env. Refusing to start in live mode.'
  );
}

const PUBLIC_RPC = String(process.env.SOLANA_PUBLIC_RPC_URL || '').trim() || 'https://api.mainnet.solana.com';

const config = {
  PORT: num('PORT', 3000),
  HOST: String(process.env.HOST || '').trim() || '127.0.0.1',

  LIVE_TRADING,
  SIMULATION_MODE: !LIVE_TRADING,

  HELIUS_API_KEY,
  HELIUS_RPC_URL: HELIUS_RPC_URL || PUBLIC_RPC,
  HELIUS_WS_URL,
  HELIUS_CONFIGURED: Boolean(HELIUS_RPC_URL),
  SOLANA_PUBLIC_RPC_URL: PUBLIC_RPC,

  JITO_BLOCK_ENGINE_URL: String(process.env.JITO_BLOCK_ENGINE_URL || '').trim()
    || 'https://mainnet.block-engine.jito.wtf/api/v1/bundles',
  JITO_ENDPOINTS: [
    'https://mainnet.block-engine.jito.wtf/api/v1/bundles',
    'https://amsterdam.mainnet.block-engine.jito.wtf/api/v1/bundles',
    'https://frankfurt.mainnet.block-engine.jito.wtf/api/v1/bundles',
    'https://ny.mainnet.block-engine.jito.wtf/api/v1/bundles',
    'https://tokyo.mainnet.block-engine.jito.wtf/api/v1/bundles'
  ],
  DEFAULT_JITO_TIP: num('DEFAULT_JITO_TIP', 0.003),
  MAX_SOL_PER_TRADE: num('MAX_SOL_PER_TRADE', 0.1),
  MAX_SOL_PER_SESSION: num('MAX_SOL_PER_SESSION', 0.5),
  MAX_JITO_TIP_SOL: num('MAX_JITO_TIP_SOL', 0.01),
  SLIPPAGE_PCT: num('SLIPPAGE_PCT', 10),
  PRIORITY_FEE_SOL: num('PRIORITY_FEE_SOL', 0.0001),
  MAX_SLIPPAGE_PCT: 25,
  MAX_PRIORITY_FEE_SOL: 0.001,
  HTTP_TIMEOUT_MS: num('HTTP_TIMEOUT_MS', 20000),
  MIN_BUMP_INTERVAL_SEC: Math.max(5, num('MIN_BUMP_INTERVAL_SEC', 5)),
  BUNDLE_POLL_TIMEOUT_MS: num('BUNDLE_POLL_TIMEOUT_MS', 45000),
  BUNDLE_POLL_INTERVAL_MS: num('BUNDLE_POLL_INTERVAL_MS', 1500),
  JITO_MAX_TXS: 5,

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

  PUMP_PROGRAM_ID: new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'),
  PUMP_FEE_RECIPIENT: new PublicKey('CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM'),
  PUMP_GLOBAL: new PublicKey('4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf'),
  PUMP_EVENT_AUTHORITY: new PublicKey('Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1'),
  SYSTEM_PROGRAM_ID: new PublicKey('11111111111111111111111111111111'),
  TOKEN_PROGRAM_ID: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
  ASSOC_TOKEN_ACC_PROG_ID: new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'),
  RENT_SYSVAR: new PublicKey('SysvarRent111111111111111111111111111111111'),

  DEXSCREENER_API: 'https://api.dexscreener.com/latest/dex',
  PUMPPORTAL_API: 'https://pumpportal.fun/api',
  PUMPPORTAL_WS: 'wss://pumpportal.fun/api/data'
};

if (config.DEFAULT_JITO_TIP <= 0 || config.DEFAULT_JITO_TIP > config.MAX_JITO_TIP_SOL) {
  throw new Error(`DEFAULT_JITO_TIP must be positive and no greater than MAX_JITO_TIP_SOL (${config.MAX_JITO_TIP_SOL})`);
}
if (config.SLIPPAGE_PCT <= 0 || config.SLIPPAGE_PCT > config.MAX_SLIPPAGE_PCT) {
  throw new Error(`SLIPPAGE_PCT must be between 0 and ${config.MAX_SLIPPAGE_PCT}`);
}
if (config.PRIORITY_FEE_SOL < 0 || config.PRIORITY_FEE_SOL > config.MAX_PRIORITY_FEE_SOL) {
  throw new Error(`PRIORITY_FEE_SOL must be between 0 and ${config.MAX_PRIORITY_FEE_SOL}`);
}
if (config.MAX_SOL_PER_TRADE <= 0 || config.MAX_SOL_PER_SESSION < config.MAX_SOL_PER_TRADE) {
  throw new Error('MAX_SOL_PER_SESSION must be greater than or equal to MAX_SOL_PER_TRADE, and both must be positive');
}

module.exports = config;
