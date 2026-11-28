require('dotenv').config();
const { PublicKey } = require('@solana/web3.js');

const { ignoredModeEnv } = require('./simulationMode');

function rpsEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === '') return fallback;
  if (String(raw).trim().toLowerCase() === 'unlimited') return Infinity;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Environment variable ${name} must be a positive number or unlimited`);
  }
  return value;
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

function websocketUrl(httpUrl) {
  const value = String(httpUrl || '').trim();
  if (value.startsWith('wss://') || value.startsWith('ws://')) return value;
  if (value.startsWith('https://')) return `wss://${value.slice('https://'.length)}`;
  if (value.startsWith('http://')) return `ws://${value.slice('http://'.length)}`;
  return '';
}

const HELIUS_API_KEY = String(process.env.HELIUS_API_KEY || '').trim();
const HELIUS_RPC_URL = String(process.env.HELIUS_RPC_URL || '').trim()
  || (HELIUS_API_KEY ? `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}` : '');
const HELIUS_WS_URL = String(process.env.HELIUS_WS_URL || '').trim()
  || (HELIUS_API_KEY ? `wss://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}` : '')
  || websocketUrl(HELIUS_RPC_URL);

const PUBLIC_RPC = String(process.env.SOLANA_PUBLIC_RPC_URL || '').trim() || 'https://api.mainnet.solana.com';
const QUICKNODE_RPC_URL = String(process.env.QUICKNODE_RPC_URL || '').trim();
const QUICKNODE_WS_URL = String(process.env.QUICKNODE_WS_URL || '').trim() || websocketUrl(QUICKNODE_RPC_URL);

function alchemyEndpoints(env = process.env) {
  const key = String(env.ALCHEMY_API_KEY || '').trim();
  const httpUrl = String(env.ALCHEMY_RPC_URL || '').trim()
    || (key ? `https://solana-mainnet.g.alchemy.com/v2/${key}` : '');
  const wsUrl = String(env.ALCHEMY_WS_URL || '').trim() || websocketUrl(httpUrl);
  return { httpUrl, wsUrl, configured: Boolean(httpUrl) };
}

const alchemy = alchemyEndpoints();

const config = {
  PORT: num('PORT', 3000),
  HOST: String(process.env.HOST || '').trim() || '127.0.0.1',

  // Always simulation at process start. The dashboard switch is the only way into live mode.
  SIMULATION_MODE: true,
  ignoredModeEnv: ignoredModeEnv(process.env),

  HELIUS_API_KEY,
  HELIUS_RPC_URL: HELIUS_RPC_URL || PUBLIC_RPC,
  HELIUS_WS_URL,
  HELIUS_CONFIGURED: Boolean(HELIUS_RPC_URL),
  QUICKNODE_RPC_URL,
  QUICKNODE_WS_URL,
  QUICKNODE_CONFIGURED: Boolean(QUICKNODE_RPC_URL),
  ALCHEMY_API_KEY: String(process.env.ALCHEMY_API_KEY || '').trim(),
  ALCHEMY_RPC_URL: alchemy.httpUrl,
  ALCHEMY_WS_URL: alchemy.wsUrl,
  ALCHEMY_CONFIGURED: alchemy.configured,
  SOLANA_PUBLIC_RPC_URL: PUBLIC_RPC,
  QUICKNODE_RPS: rpsEnv('QUICKNODE_RPS', 12),
  ALCHEMY_RPS: rpsEnv('ALCHEMY_RPS', 12),
  HELIUS_RPS: rpsEnv('HELIUS_RPS', Infinity),
  PUBLIC_RPS: rpsEnv('PUBLIC_RPS', 4),

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
  PUMPPORTAL_WS: 'wss://pumpportal.fun/api/data',
  PUMPPORTAL_API_KEY: String(process.env.PUMPPORTAL_API_KEY || '').trim(),

  SECOND_PUMP_MCAP_USD: num('SECOND_PUMP_MCAP_USD', 100000),
  BLEED_FLOOR_MCAP_USD: num('BLEED_FLOOR_MCAP_USD', 50000),
  PUMP_MIN_RISE_PCT: num('PUMP_MIN_RISE_PCT', 50),
  PUMP_MIN_DRAWDOWN_PCT: num('PUMP_MIN_DRAWDOWN_PCT', 50),
  PUMP_MIN_DIP_MS: num('PUMP_MIN_DIP_MS', 60_000),
  NEAR_MIGRATION_PCT: num('NEAR_MIGRATION_PCT', 90),

  FARM_RIDE_ENABLED: String(process.env.FARM_RIDE_ENABLED || '').trim() === '1',
  FARM_RIDE_MAX_SOL: num('FARM_RIDE_MAX_SOL', 0.02),
  FARM_RIDE_KOL_WINDOW_MS: num('FARM_RIDE_KOL_WINDOW_MS', 10 * 60 * 1000),
  FARM_RIDE_STOP_PCT: num('FARM_RIDE_STOP_PCT', 25),
  FARM_RIDE_MAX_HOLD_MS: num('FARM_RIDE_MAX_HOLD_MS', 30 * 60 * 1000)
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
if (config.SECOND_PUMP_MCAP_USD <= 0 || config.BLEED_FLOOR_MCAP_USD <= 0) {
  throw new Error('SECOND_PUMP_MCAP_USD and BLEED_FLOOR_MCAP_USD must be positive');
}
if (config.PUMP_MIN_RISE_PCT <= 0 || config.PUMP_MIN_DRAWDOWN_PCT <= 0 || config.PUMP_MIN_DRAWDOWN_PCT >= 100) {
  throw new Error('PUMP_MIN_RISE_PCT must be positive and PUMP_MIN_DRAWDOWN_PCT must be between 0 and 100');
}
if (config.NEAR_MIGRATION_PCT <= 0 || config.NEAR_MIGRATION_PCT > 100) {
  throw new Error('NEAR_MIGRATION_PCT must be between 0 and 100');
}
if (config.FARM_RIDE_MAX_SOL <= 0 || config.FARM_RIDE_MAX_SOL > config.MAX_SOL_PER_TRADE) {
  throw new Error('FARM_RIDE_MAX_SOL must be positive and no greater than MAX_SOL_PER_TRADE');
}
if (config.FARM_RIDE_STOP_PCT <= 0 || config.FARM_RIDE_STOP_PCT >= 100 || config.FARM_RIDE_KOL_WINDOW_MS <= 0 || config.FARM_RIDE_MAX_HOLD_MS <= 0) {
  throw new Error('Farm ride stop, KOL window, and max hold must be positive, and the stop must be under 100%');
}

config.alchemyEndpoints = alchemyEndpoints;
module.exports = config;
