const { PublicKey } = require('@solana/web3.js');
const { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } = require('@solana/spl-token');

const CLASSIC_TOKEN_PROGRAM = TOKEN_PROGRAM_ID.toBase58();
const TOKEN_2022_PROGRAM = TOKEN_2022_PROGRAM_ID.toBase58();
const mintProgramCache = new Map();

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
  programFromOwner,
  resolveMintTokenProgram,
  ataAddress,
  accountKeysFromTransaction,
  solSpentFromMeta,
  tokenChangeFromMeta,
  noTokensMessage,
  readOwnerTokenBalance
};
