const { PublicKey } = require('@solana/web3.js');
const { decodeTokenAmount } = require('./subscriptionBook');
const { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } = require('@solana/spl-token');

const CLASSIC_TOKEN_PROGRAM = TOKEN_PROGRAM_ID.toBase58();
const TOKEN_2022_PROGRAM = TOKEN_2022_PROGRAM_ID.toBase58();
const PUMP_SUPPLY_UI = 1_000_000_000;
const mintProgramCache = new Map();
const mintSupplyCache = new Map();

function programFromOwner(owner) {
  const id = owner && owner.toBase58 ? owner.toBase58() : String(owner || '');
  if (id === TOKEN_2022_PROGRAM) return TOKEN_2022_PROGRAM_ID;
  return TOKEN_PROGRAM_ID;
}

async function resolveMintTokenProgram(connection, mint) {
  const key = String(mint || '');
  if (!key) return TOKEN_PROGRAM_ID;
  if (mintProgramCache.has(key)) return mintProgramCache.get(key);
  const info = await connection.getAccountInfo(new PublicKey(key), 'confirmed');
  const program = programFromOwner(info && info.owner);
  mintProgramCache.set(key, program);
  return program;
}

function ataAddress(owner, mint, programId) {
  const program = programId
    ? (programId.toBase58 ? programId : new PublicKey(programId))
    : TOKEN_PROGRAM_ID;
  return getAssociatedTokenAddressSync(
    new PublicKey(mint),
    new PublicKey(owner),
    false,
    program
  ).toBase58();
}

function accountKeysFromTransaction(tx) {
  const message = tx && tx.transaction && tx.transaction.message;
  if (!message) return [];
  if (typeof message.getAccountKeys === 'function') {
    const loaded = message.getAccountKeys({
      accountKeysFromLookups: tx.meta && tx.meta.loadedAddresses
    });
    const keys = loaded.staticAccountKeys.map(key => key.toBase58());
    const lookups = tx.meta && tx.meta.loadedAddresses;
    (lookups && lookups.writable || []).forEach(key => keys.push(key.toBase58()));
    (lookups && lookups.readonly || []).forEach(key => keys.push(key.toBase58()));
    return keys;
  }
  return (message.staticAccountKeys || message.accountKeys || []).map(key => key.toBase58 ? key.toBase58() : String(key));
}

// Positive means the wallet lost SOL (a buy, fees, and new token-account rent).
function solSpentFromMeta(meta, accountKeys, owner) {
  if (!meta || !Array.isArray(accountKeys)) return null;
  const index = accountKeys.indexOf(owner);
  if (index < 0) return null;
  const pre = meta.preBalances[index];
  const post = meta.postBalances[index];
  if (!Number.isFinite(pre) || !Number.isFinite(post)) return null;
  return (pre - post) / 1e9;
}

function tokenChangeFromMeta(meta, owner, mint) {
  const find = (rows) => (rows || []).find(row => row && row.owner === owner && row.mint === mint);
  const pre = find(meta && meta.preTokenBalances);
  const post = find(meta && meta.postTokenBalances);
  const ui = (row) => {
    if (!row || !row.uiTokenAmount) return 0;
    const text = row.uiTokenAmount.uiAmountString;
    const value = text != null ? Number(text) : Number(row.uiTokenAmount.uiAmount);
    return Number.isFinite(value) ? value : 0;
  };
  const preUi = ui(pre);
  const postUi = ui(post);
  return {
    preUi,
    postUi,
    delta: postUi - preUi,
    programId: (post || pre) && (post || pre).programId || null
  };
}

function noTokensMessage(address, mint) {
  return `No tokens found for ${address} on ${mint}. Checked Token-2022 and classic token accounts.`;
}

async function readMintSupply(connection, mint) {
  const key = String(mint || '');
  if (!key) return { ui: PUMP_SUPPLY_UI, decimals: 6, source: 'default' };
  if (mintSupplyCache.has(key)) return mintSupplyCache.get(key);
  let result = { ui: PUMP_SUPPLY_UI, decimals: 6, source: 'default' };
  try {
    const supply = await connection.getTokenSupply(new PublicKey(key), 'confirmed');
    const text = supply && supply.value && (supply.value.uiAmountString != null ? supply.value.uiAmountString : supply.value.uiAmount);
    const ui = Number(text);
    const decimals = Number(supply && supply.value && supply.value.decimals);
    if (Number.isFinite(ui) && ui > 0) {
      result = { ui, decimals: Number.isFinite(decimals) ? decimals : 6, source: 'mint' };
    }
  } catch (err) {
    result = { ui: PUMP_SUPPLY_UI, decimals: 6, source: 'default' };
  }
  mintSupplyCache.set(key, result);
  return result;
}

async function readMintTokenBalances(connection, owners, mint) {
  const list = (owners || []).map(owner => String(owner || '')).filter(Boolean);
  const balances = new Map();
  if (!list.length) return balances;
  if (connection && typeof connection.getMultipleAccountsInfo === 'function') {
    try {
      const program = await resolveMintTokenProgram(connection, mint);
      const supply = await readMintSupply(connection, mint);
      const decimals = supply.decimals || 6;
      const atas = list.map(owner => new PublicKey(ataAddress(owner, mint, program)));
      const infos = await connection.getMultipleAccountsInfo(atas, 'confirmed');
      const rawAccount = info => info == null || (info.data && !info.data.parsed);
      if (Array.isArray(infos) && infos.length === list.length && infos.every(rawAccount)) {
        list.forEach((owner, index) => {
          const info = infos[index];
          const raw = info && info.data ? decodeTokenAmount(info.data) : 0;
          balances.set(owner, {
            ui: raw / (10 ** decimals),
            raw: String(raw),
            decimals,
            programId: program.toBase58()
          });
        });
        return balances;
      }
    } catch (err) {
      // Fall through to one parsed read per wallet.
    }
  }
  for (const owner of list) {
    balances.set(owner, await readOwnerTokenBalance(connection, owner, mint));
  }
  return balances;
}

async function readOwnerTokenBalance(connection, owner, mint) {
  const response = await connection.getParsedTokenAccountsByOwner(
    new PublicKey(owner),
    { mint: new PublicKey(mint) },
    'confirmed'
  );
  let raw = 0n;
  let decimals = 6;
  let programId = null;
  for (const item of response.value || []) {
    const info = item.account.data.parsed.info;
    raw += BigInt(info.tokenAmount.amount);
    decimals = Number(info.tokenAmount.decimals) || decimals;
    programId = item.account.owner.toBase58();
  }
  return {
    ui: Number(raw) / (10 ** decimals),
    raw: raw.toString(),
    decimals,
    programId
  };
}

module.exports = {
  CLASSIC_TOKEN_PROGRAM,
  TOKEN_2022_PROGRAM,
  PUMP_SUPPLY_UI,
  programFromOwner,
  resolveMintTokenProgram,
  ataAddress,
  accountKeysFromTransaction,
  solSpentFromMeta,
  tokenChangeFromMeta,
  noTokensMessage,
  readOwnerTokenBalance,
  readMintTokenBalances,
  readMintSupply
};
