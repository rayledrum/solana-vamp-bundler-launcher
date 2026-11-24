const { PublicKey } = require('@solana/web3.js');
const { getAssociatedTokenAddressSync } = require('@solana/spl-token');

function associatedToken(owner, mint) {
  return getAssociatedTokenAddressSync(new PublicKey(mint), new PublicKey(owner)).toBase58();
}

// One SOL account per wallet, plus that wallet's ATA for the active mint only.
function planAccounts({ wallets, mint }) {
  const accounts = [];
  const seen = new Set();
  for (const owner of wallets || []) {
    const address = String(owner || '').trim();
    if (!address) continue;
    const key = `sol:${address}`;
    if (seen.has(key)) continue;
    seen.add(key);
    accounts.push({ key, address, kind: 'sol', owner: address });
  }
  const mintText = String(mint || '').trim();
  if (!mintText) return accounts;
  for (const owner of wallets || []) {
    const address = String(owner || '').trim();
    if (!address) continue;
    let ata = '';
    try {
      ata = associatedToken(address, mintText);
    } catch (err) {
      continue;
    }
    const key = `token:${address}:${mintText}`;
    if (seen.has(key)) continue;
    seen.add(key);
    accounts.push({ key, address: ata, kind: 'token', owner: address, mint: mintText });
  }
  return accounts;
}

function diffSubscriptions(currentKeys, nextAccounts) {
  const nextKeys = new Set(nextAccounts.map(account => account.key));
  return {
    subscribe: nextAccounts.filter(account => !currentKeys.has(account.key)),
    unsubscribe: [...currentKeys].filter(key => !nextKeys.has(key))
  };
}

function backoffMs(retry) {
  const step = Math.max(0, Number(retry) || 0);
  return Math.min(30000, 1000 * (2 ** step));
}

function decodeTokenAmount(data) {
  if (!data) return 0;
  const buf = Buffer.from(data);
  if (buf.length < 72) return 0;
  return Number(buf.readBigUInt64LE(64));
}

module.exports = {
  planAccounts,
  diffSubscriptions,
  backoffMs,
  decodeTokenAmount,
  associatedToken
};
