const { PublicKey, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const { planAccounts, diffSubscriptions, backoffMs, decodeTokenAmount } = require('./subscriptionBook');

const TOKEN_DECIMALS = 6;

class LiveAccountFeed {
  constructor(options = {}) {
    this.connection = options.connection;
    this.isLive = options.isLive || (() => false);
    this.onSol = options.onSol || (() => {});
    this.onToken = options.onToken || (() => {});
    this.onStatus = options.onStatus || (() => {});
    this.schedule = options.schedule || ((fn, ms) => setTimeout(fn, ms));
    this.commitment = options.commitment || 'processed';
    this.current = new Map();
    this.wallets = [];
    this.mint = null;
    this.timer = null;
    this.retry = 0;
    this.connected = false;
    this.stopped = true;
  }

  start() {
    this.stopped = false;
    this.apply();
    this.emitStatus();
  }

  stop() {
    this.stopped = true;
    this.clearTimer();
    this.unsubscribeAll();
    this.connected = false;
    this.emitStatus();
  }

  setWallets(wallets) {
    this.wallets = Array.isArray(wallets) ? wallets.filter(Boolean) : [];
    if (!this.stopped) this.apply();
  }

  setMint(mint) {
    this.mint = mint || null;
    if (!this.stopped) this.apply();
  }

  apply() {
    if (this.stopped || !this.isLive()) {
      this.unsubscribeAll();
      this.emitStatus();
      return;
    }
    const next = planAccounts({ wallets: this.wallets, mint: this.mint });
    const diff = diffSubscriptions(new Set(this.current.keys()), next);
    diff.unsubscribe.forEach(key => this.unsubscribeKey(key));
    diff.subscribe.forEach(account => this.subscribeAccount(account));
    this.connected = this.current.size > 0;
    this.emitStatus();
  }

  subscribeAccount(account) {
    if (!this.connection || typeof this.connection.onAccountChange !== 'function') return;
    const id = this.connection.onAccountChange(
      new PublicKey(account.address),
      (info) => this.handleAccount(account, info),
      this.commitment
    );
    this.current.set(account.key, { id, account });
  }

  unsubscribeKey(key) {
    const row = this.current.get(key);
    if (!row) return;
    try {
      this.connection.removeAccountChangeListener(row.id);
    } catch (err) { /* listener already gone */ }
    this.current.delete(key);
  }

  unsubscribeAll() {
    [...this.current.keys()].forEach(key => this.unsubscribeKey(key));
  }

  handleAccount(account, info) {
    if (account.kind === 'sol') {
      const lamports = info && Number.isFinite(info.lamports) ? info.lamports : 0;
      this.onSol({
        address: account.owner,
        liveBalance: lamports / LAMPORTS_PER_SOL,
        at: Date.now()
      });
      return;
    }
    const raw = decodeTokenAmount(info && info.data);
    this.onToken({
      address: account.owner,
      mint: account.mint,
      raw,
      tokenAmount: raw / (10 ** TOKEN_DECIMALS),
      at: Date.now()
    });
  }

  handleClose() {
    this.connected = false;
    this.emitStatus();
    if (this.stopped || !this.isLive()) return;
    this.clearTimer();
    const delay = backoffMs(this.retry);
    this.retry += 1;
    this.timer = this.schedule(() => this.resubscribe(), delay);
  }

  clearTimer() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  async resubscribe() {
    this.timer = null;
    if (this.stopped || !this.isLive()) return;
    this.unsubscribeAll();
    this.apply();
    await this.resync();
    this.retry = 0;
    this.connected = true;
    this.emitStatus();
  }

  async resync() {
    if (!this.connection || typeof this.connection.getMultipleAccountsInfo !== 'function') return;
    const rows = [...this.current.values()];
    if (!rows.length) return;
    const infos = await this.connection.getMultipleAccountsInfo(
      rows.map(row => new PublicKey(row.account.address)),
      'confirmed'
    );
    rows.forEach((row, index) => {
      const info = infos && infos[index];
      this.handleAccount(row.account, info || (row.account.kind === 'sol' ? { lamports: 0 } : { data: Buffer.alloc(0) }));
    });
  }

  emitStatus() {
    this.onStatus({
      connected: !this.stopped && this.connected && this.isLive(),
      subscribed: this.current.size,
      live: this.isLive() && !this.stopped,
      mint: this.mint
    });
  }

  keys() {
    return [...this.current.keys()];
  }
}

module.exports = { LiveAccountFeed, TOKEN_DECIMALS };
