const {
  PublicKey,
  TransactionInstruction,
  SystemProgram,
  SYSVAR_RENT_PUBKEY
} = require('@solana/web3.js');
const {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress
} = require('@solana/spl-token');
const axios = require('axios');
const config = require('./config');
const { curveState, tokensOutForSol, solOutForTokens } = require('./bondingCurve');
const { readMintMetadata } = require('./tokenMetadata');
const { fetchPumpJson } = require('./pumpApi');

const TOTAL_SUPPLY = 1000000000;

class PumpFunService {
  constructor() {
    this.programId = config.PUMP_PROGRAM_ID;
  }

  // Derive Bonding Curve PDA
  getBondingCurvePDA(mint) {
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from('bonding-curve'), mint.toBuffer()],
      this.programId
    );
    return pda;
  }

  // Derive Associated Bonding Curve Token Account
  async getAssociatedBondingCurve(mint, bondingCurve) {
    return await getAssociatedTokenAddress(
      mint,
      bondingCurve,
      true,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );
  }

  // Calculate tokens received for a given SOL amount (constant product AMM: x * y = k)
  calculateBuyOutput(solAmount, currentRealSol = 0) {
    return tokensOutForSol(solAmount, currentRealSol) * 0.99;
  }

  calculateSellOutput(tokenAmount, currentRealSol = 0) {
    return solOutForTokens(tokenAmount, currentRealSol) * 0.99;
  }

  // Modeled curve. Progress follows real-token reserves, and the destination is PumpSwap.
  calculateProgress(solInCurve) {
    return curveState(solInCurve).progressPct;
  }

  // Upload metadata to Pump.fun IPFS (free public endpoint)
  async uploadMetadata({ name, symbol, description, twitter, telegram, website, fileBuffer, fileName }) {
    try {
      const FormData = require('form-data');
      const formData = new FormData();
      formData.append('name', name);
      formData.append('symbol', symbol);
      formData.append('description', description || '');
      if (twitter) formData.append('twitter', twitter);
      if (telegram) formData.append('telegram', telegram);
      if (website) formData.append('website', website);
      formData.append('showName', 'true');

      if (fileBuffer) {
        formData.append('file', fileBuffer, { filename: fileName || 'logo.png' });
      }

      const response = await axios.post('https://pump.fun/api/ipfs', formData, {
        headers: formData.getHeaders(),
        timeout: 25000
      });

      return {
        metadataUri: response.data.metadataUri || response.data.uri,
        metadata: response.data.metadata
      };
    } catch (err) {
      const walletManager = require('./walletManager');
      if (!walletManager.simulationMode) {
        throw new Error(`IPFS metadata upload failed in live mode: ${err.message}`);
      }
      console.warn('Simulation IPFS fallback triggered:', err.message);
      return {
        metadataUri: `https://ipfs.io/ipfs/sim-${Date.now()}`,
        metadata: { name, symbol, description },
        simulated: true
      };
    }
  }

  // Fetch live token curve info from DexScreener (Free)
  async getTokenDexInfo(tokenMint) {
    try {
      const res = await axios.get(`${config.DEXSCREENER_API}/tokens/${tokenMint}`, {
        timeout: 5000
      });
      if (res.data && res.data.pairs && res.data.pairs.length > 0) {
        const pair = res.data.pairs[0];
        return {
          priceUsd: parseFloat(pair.priceUsd || '0'),
          priceNative: parseFloat(pair.priceNative || '0'),
          marketCap: pair.marketCap || 0,
          fdv: pair.fdv || 0,
          volume24h: pair.volume ? pair.volume.h24 : 0,
          pairAddress: pair.pairAddress,
          dexId: pair.dexId,
          liquidityUsd: pair.liquidity ? pair.liquidity.usd : 0,
          baseToken: pair.baseToken
        };
      }
    } catch (err) {
      // ignore
    }
    return null;
  }

  // Pump.fun chart resolutions. 5s is not a native bar, so it is loaded as 1s
  // and bucketed in the browser. That keeps the 1s series available.
  pumpChartRes(timeframe) {
    const tf = String(timeframe || '1m');
    if (tf === '1s' || tf === '5s') return '1s';
    if (tf === '15s' || tf === '30s' || tf === '1m' || tf === '5m') return tf;
    return '1m';
  }

  normalizeCandles(rows) {
    return rows.filter(c => Number.isFinite(c.time) && Number.isFinite(c.close) && c.close > 0);
  }

  // Pump.fun's own OHLCV. price_quote is SOL per token. 1s is retained for 7 days;
  // older history is served at 1m and servedRes says which width came back.
  async getPumpChartCandles(mint, timeframe) {
    const res = this.pumpChartRes(timeframe);
    const chainId = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
    const body = await fetchPumpJson(`/candles/${chainId}/${encodeURIComponent(mint)}?res=${encodeURIComponent(res)}&count=300&measure=price_quote`) || {};
    const solUsd = this._solUsd;
    const candles = this.normalizeCandles((body.candles || []).map(row => {
      const volumeUsd = Number(row.volumeUsd) || 0;
      return {
        time: Number(row.openTimeMs),
        open: Number(row.open),
        high: Number(row.high),
        low: Number(row.low),
        close: Number(row.close),
        volume: solUsd > 0 ? volumeUsd / solUsd : volumeUsd
      };
    }));
    if (!candles.length) return null;
    return {
      candles,
      servedRes: body.served?.res || res,
      source: 'pump.fun',
      priceNative: candles[candles.length - 1].close
    };
  }

  // Fallback when Pump.fun has no bars. Minute OHLCV only.
  async getGeckoChartCandles(mint, timeframe) {
    const aggregate = timeframe === '5m' ? 5 : 1;
    const poolsRes = await axios.get(
      `https://api.geckoterminal.com/api/v2/networks/solana/tokens/${mint}/pools?page=1`,
      { timeout: 8000, headers: { Accept: 'application/json' } }
    );
    const pools = poolsRes.data?.data || [];
    const solPool = pools.find(p => String(p.attributes?.name || '').endsWith('/ SOL')) || pools[0];
    const poolAddress = solPool?.attributes?.address;
    if (!poolAddress) return null;
    const ohlcvRes = await axios.get(
      `https://api.geckoterminal.com/api/v2/networks/solana/pools/${poolAddress}/ohlcv/minute`,
      {
        timeout: 8000,
        headers: { Accept: 'application/json' },
        params: { aggregate, limit: 80, currency: 'token', token: 'base' }
      }
    );
    const meta = ohlcvRes.data?.meta?.base || {};
    const list = ohlcvRes.data?.data?.attributes?.ohlcv_list || [];
    const candles = this.normalizeCandles(list.slice().reverse().map(row => ({
      time: Number(row[0]) * 1000,
      open: Number(row[1]),
      high: Number(row[2]),
      low: Number(row[3]),
      close: Number(row[4]),
      volume: Number(row[5]) || 0
    })));
    if (!candles.length) return null;
    return {
      candles,
      servedRes: aggregate === 5 ? '5m' : '1m',
      source: 'geckoterminal',
      symbol: meta.symbol || null,
      name: meta.name || null,
      priceNative: candles[candles.length - 1].close
    };
  }

  // OHLC for the chart. Pump.fun first (including 1s), then GeckoTerminal.
  // Live trades on the client keep filling the selected timeframe after this history.
  async getChartCandles(tokenMint, timeframe = '1m') {
    const mint = String(tokenMint || '').trim();
    const tf = String(timeframe || '1m');
    const result = {
      mint,
      symbol: null,
      name: null,
      priceNative: null,
      source: 'seed',
      servedRes: tf,
      timeframe: tf,
      candles: []
    };
    if (!mint) return result;

    let dex = null;
    try {
      dex = await this.getTokenDexInfo(mint);
    } catch (err) {
      dex = null;
    }
    if (dex) {
      result.priceNative = dex.priceNative > 0 ? dex.priceNative : null;
      result.symbol = dex.baseToken?.symbol || null;
      result.name = dex.baseToken?.name || null;
      if (dex.priceNative > 0 && dex.priceUsd > 0) {
        this._solUsd = dex.priceUsd / dex.priceNative;
      }
    }

    try {
      const pump = await this.getPumpChartCandles(mint, tf);
      if (pump) {
        result.candles = pump.candles;
        result.priceNative = pump.priceNative;
        result.source = pump.source;
        result.servedRes = pump.servedRes;
        await this.attachMintIdentity(mint, result);
        return result;
      }
    } catch (err) {
      console.warn('[PumpFun] Pump.fun candle fetch failed:', err.message);
    }

    try {
      const gecko = await this.getGeckoChartCandles(mint, tf);
      if (gecko) {
        result.candles = gecko.candles;
        result.priceNative = gecko.priceNative;
        result.source = gecko.source;
        result.servedRes = gecko.servedRes;
        result.symbol = gecko.symbol || result.symbol;
        result.name = gecko.name || result.name;
        await this.attachMintIdentity(mint, result);
        return result;
      }
    } catch (err) {
      console.warn('[PumpFun] GeckoTerminal candle fetch failed:', err.message);
    }

    result.candles = [];
    result.source = 'empty';
    await this.attachMintIdentity(mint, result);
    return result;
  }
}

PumpFunService.prototype.lookupMintMetadata = function lookupMintMetadata(mint) {
  const walletManager = require('./walletManager');
  return readMintMetadata(walletManager.connection, mint);
};

PumpFunService.prototype.attachMintIdentity = async function attachMintIdentity(mint, result) {
  try {
    const meta = await this.lookupMintMetadata(mint);
    if (meta && meta.symbol) result.symbol = meta.symbol;
    if (meta && meta.name) result.name = meta.name;
  } catch (err) { /* candles still render; the header keeps the short mint */ }
  return result;
};

PumpFunService.prototype.solPriceUsd = function solPriceUsd() {
  const rate = Number(this._solUsd);
  return rate > 0 ? rate : null;
};

module.exports = new PumpFunService();
