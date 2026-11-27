const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const { PublicKey } = require('@solana/web3.js');

process.env.WALLETS_FILE = path.join(os.tmpdir(), `holdings-wallets-${process.pid}.json`);
const walletManager = require('../src/walletManager');
const { setLiveTradingOverride } = require('../src/rpc');
const tradingEngine = require('../src/tradingEngine');
const pumpfun = require('../src/pumpfun');
const { TOKEN_2022_PROGRAM } = require('../src/tokenAccounts');

const MINT = 'FUNuAFQJyzBXqk8pSXEtdH42odnti7hQFFraJtd2pump';
const MASTER = walletManager.masterWallet.publicKey.toBase58();

function tokenAccount(amount) {
  return {
    value: [{
      account: {
        owner: new PublicKey(TOKEN_2022_PROGRAM),
        data: { parsed: { info: { tokenAmount: { amount, decimals: 6 } } } }
      }
    }]
  };
}

test('loading a live mint seeds Token-2022 balances and leaves cost unknown', async () => {
  walletManager.setSimulationMode(false);
  setLiveTradingOverride('allow');
  tradingEngine.connectPumpPortal = () => {};
  tradingEngine.onMintChange = () => {};
  const originalDex = pumpfun.getTokenDexInfo.bind(pumpfun);
  pumpfun.getTokenDexInfo = async () => null;
  const connection = walletManager.connection;
  const originalParsed = connection.getParsedTokenAccountsByOwner.bind(connection);
  const originalMany = connection.getMultipleAccountsInfo.bind(connection);
  connection.getParsedTokenAccountsByOwner = async (owner) => {
    if (owner.toBase58() === MASTER) return tokenAccount('63724256335');
    return { value: [] };
  };
  connection.getMultipleAccountsInfo = async (keys) => keys.map(() => ({ lamports: 87_531_384 }));

  try {
    tradingEngine.setActiveToken(MINT);
    const before = await tradingEngine.getLiveStats();
    const master = before.wallets.find(row => row.role === 'Master Dev');
    assert.equal(master.tokens, 63724.256335);
    assert.equal(master.solInvested, null);
    assert.equal(master.pnlSol, null);
    assert.equal(before.pnlSol, null);
    assert.equal(before.totalSolInvested, null);

    tradingEngine.noteMarketPrice(MINT, 0.0000001465, { simulated: false });
    const priced = await tradingEngine.getLiveStats();
    const again = priced.wallets.find(row => row.role === 'Master Dev');
    const expected = Number((63724.256335 * 0.0000001465).toFixed(4));
    assert.equal(again.currentValue, expected);
    assert.equal(again.pnlSol, null);
    assert.equal(priced.currentSolValue, expected);

    tradingEngine.noteMarketPrice(MINT, 0.0000002, { simulated: false });
    const next = await tradingEngine.getLiveStats();
    const moved = next.wallets.find(row => row.role === 'Master Dev');
    assert.equal(moved.currentValue, Number((63724.256335 * 0.0000002).toFixed(4)));
    assert.notEqual(moved.currentValue, again.currentValue);

    let sellBody = null;
    tradingEngine.portalFetch = async (body) => {
      sellBody = body;
      throw new Error('portal-stop');
    };
    tradingEngine.positions.set(MASTER, { tokens: 0, solInvested: 0, costKnown: true });
    const sold = await tradingEngine.executeSell({ pct: 100, walletAddresses: [MASTER] });
    assert.equal(sellBody.action, 'sell');
    assert.equal(sellBody.mint, MINT);
    assert.equal(sellBody.amount, '100%');
    assert.match(sold.error, /portal-stop/);
    assert.equal(sold.success, false);
    assert.equal(tradingEngine.tradePool(), 'auto');
    tradingEngine.curve = { mint: MINT, complete: false, progressPct: 12, realSol: 4 };
    assert.equal(tradingEngine.tradePool(), 'pump');
    tradingEngine.curve = { mint: MINT, complete: true, progressPct: 100, realSol: 42 };
    assert.equal(tradingEngine.tradePool(), 'pump-amm');
  } finally {
    connection.getParsedTokenAccountsByOwner = originalParsed;
    connection.getMultipleAccountsInfo = originalMany;
    pumpfun.getTokenDexInfo = originalDex;
    setLiveTradingOverride(null);
    walletManager.setSimulationMode(true);
  }
});
