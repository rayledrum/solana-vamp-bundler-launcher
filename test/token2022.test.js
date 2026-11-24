const test = require('node:test');
const assert = require('node:assert/strict');
const { PublicKey } = require('@solana/web3.js');
const { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } = require('@solana/spl-token');
const {
  ataAddress,
  solSpentFromMeta,
  tokenChangeFromMeta,
  noTokensMessage,
  readOwnerTokenBalance,
  resolveMintTokenProgram,
  TOKEN_2022_PROGRAM
} = require('../src/tokenAccounts');
const { decodeTradeEvent, parseProgramDataLogs } = require('../src/curveFeed');
const { planAccounts } = require('../src/subscriptionBook');

const OWNER = '7shP6fMpVU4K8WKD1VVUUftfxKrSfLnDA2cmfPVc4FCo';
const MINT = 'FUNuAFQJyzBXqk8pSXEtdH42odnti7hQFFraJtd2pump';
const TOKEN_2022_ATA = '7U42bjVesdWVjAStThJ9hpgkiCgSAPBfwaeBVCoDbtuA';
const CLASSIC_ATA = 'G2rZ33x1Drd91vTq5Zx4aDNjacL9312dbrC9qXiA3AoG';
const REAL_PROGRAM_DATA = 'vdt/007mYe7XBw94gFwxuP5p0U7utiwQcf5X0JtSuhUfa5Am7il+n65xjgAAAAAAT/xC1g4AAAABZiLSKY0XV1MSYn2tCyWxYXaoy/NP94JSLpFFptJizkzZWwVrAAAAANz0W/0PAAAA5WovU06qAQDcSDgBCQAAAOXSHAe9qwAAF2yyhLW8UJXMNDAWk+LPaOIiS0GMY5xFyKaFWGhaCG1fAAAAAAAAAG1aAQAAAAAATqIjYHQxcIIleduaMCvZlGcaUvFIWbkoontka99CZ8AeAAAAAAAAAGZtAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAwAAAGJ1eQAAAAAAAAAAAAAAAAAAAAAAiBMAAAAAAAA2rQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAK5xjgAAAAAA3PRb/Q8AAADcSDgBCQAAAAAAAAAAAAAAAAAAAAAAAACOs1scAAAAAAAAAAAAAAAA';

test('Token-2022 ATA differs from the classic ATA for the live mint', () => {
  assert.equal(ataAddress(OWNER, MINT, TOKEN_2022_PROGRAM_ID), TOKEN_2022_ATA);
  assert.equal(ataAddress(OWNER, MINT, TOKEN_PROGRAM_ID), CLASSIC_ATA);
  assert.notEqual(TOKEN_2022_ATA, CLASSIC_ATA);
  const planned = planAccounts({ wallets: [OWNER], mint: MINT, tokenProgramId: TOKEN_2022_PROGRAM });
  const token = planned.find(row => row.kind === 'token');
  assert.equal(token.address, TOKEN_2022_ATA);
});

test('confirmed buy meta records the real SOL spent and Token-2022 balance', () => {
  const keys = [OWNER, TOKEN_2022_ATA];
  const meta = {
    preBalances: [99995005, 0],
    postBalances: [87531384, 2039280],
    fee: 105000,
    preTokenBalances: [],
    postTokenBalances: [{
      accountIndex: 1,
      mint: MINT,
      owner: OWNER,
      programId: TOKEN_2022_PROGRAM,
      uiTokenAmount: { uiAmountString: '63724.256335', amount: '63724256335', decimals: 6 }
    }]
  };
  assert.equal(solSpentFromMeta(meta, keys, OWNER), 0.012463621);
  const change = tokenChangeFromMeta(meta, OWNER, MINT);
  assert.equal(change.postUi, 63724.256335);
  assert.equal(change.delta, 63724.256335);
  assert.equal(change.programId, TOKEN_2022_PROGRAM);
});

test('a zero on-chain balance says no tokens were found', () => {
  const message = noTokensMessage(OWNER, MINT);
  assert.match(message, /No tokens found/);
  assert.match(message, new RegExp(OWNER));
});

test('parsed token accounts sum a Token-2022 balance', async () => {
  const connection = {
    async getParsedTokenAccountsByOwner() {
      return {
        value: [{
          account: {
            owner: new PublicKey(TOKEN_2022_PROGRAM),
            data: { parsed: { info: { tokenAmount: { amount: '63724256335', decimals: 6 } } } }
          }
        }]
      };
    },
    async getAccountInfo() {
      return { owner: new PublicKey(TOKEN_2022_PROGRAM) };
    }
  };
  const balance = await readOwnerTokenBalance(connection, OWNER, MINT);
  assert.equal(balance.ui, 63724.256335);
  assert.equal(balance.programId, TOKEN_2022_PROGRAM);
  const program = await resolveMintTokenProgram(connection, MINT);
  assert.equal(program.toBase58(), TOKEN_2022_PROGRAM);
});

test('the wrapped buy Program data still decodes as a public trade', () => {
  const event = decodeTradeEvent(REAL_PROGRAM_DATA);
  assert.ok(event);
  assert.equal(event.mint, MINT);
  assert.equal(event.user, OWNER);
  assert.equal(event.isBuy, true);
  assert.equal(event.tokenAmount, 63724.256335);
  assert.ok(Math.abs(event.solAmount - 0.009335214) < 1e-9);
  assert.ok(event.priceSol > 0);
  const parsed = parseProgramDataLogs([`Program data: ${REAL_PROGRAM_DATA}`]);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].txType, 'buy');
});
