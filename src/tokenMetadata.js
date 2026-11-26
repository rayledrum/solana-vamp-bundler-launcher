const { PublicKey } = require('@solana/web3.js');
const {
  TOKEN_2022_PROGRAM_ID,
  ExtensionType,
  getExtensionData,
  unpackMint
} = require('@solana/spl-token');
const { unpack } = require('@solana/spl-token-metadata');

const METAPLEX_METADATA_PROGRAM = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');

function cleanText(value) {
  return String(value || '').replace(/\0/g, '').trim();
}

function readBorshString(buf, offset) {
  if (offset + 4 > buf.length) return null;
  const length = buf.readUInt32LE(offset);
  const start = offset + 4;
  if (length > 512 || start + length > buf.length) return null;
  return { text: cleanText(buf.subarray(start, start + length).toString('utf8')), offset: start + length };
}

function decodeMetaplexMetadata(data) {
  const buf = Buffer.from(data || []);
  if (buf.length < 1 + 32 + 32 + 4 || buf[0] !== 4) return null;
  const name = readBorshString(buf, 1 + 32 + 32);
  if (!name) return null;
  const symbol = readBorshString(buf, name.offset);
  if (!symbol) return null;
  const uri = readBorshString(buf, symbol.offset);
  if (!name.text && !symbol.text) return null;
  return { name: name.text, symbol: symbol.text, uri: uri ? uri.text : '', source: 'metaplex' };
}

function decodeToken2022Metadata(accountInfo, mint) {
  if (!accountInfo || !accountInfo.data || !accountInfo.owner) return null;
  const owner = accountInfo.owner.toBase58 ? accountInfo.owner.toBase58() : String(accountInfo.owner);
  if (owner !== TOKEN_2022_PROGRAM_ID.toBase58()) return null;
  let unpacked;
  try {
    unpacked = unpackMint(new PublicKey(mint), accountInfo, TOKEN_2022_PROGRAM_ID);
  } catch (err) {
    return null;
  }
  const extension = getExtensionData(ExtensionType.TokenMetadata, unpacked.tlvData);
  if (!extension) return null;
  try {
    const meta = unpack(extension);
    const name = cleanText(meta.name);
    const symbol = cleanText(meta.symbol);
    if (!name && !symbol) return null;
    return { name, symbol, uri: cleanText(meta.uri), source: 'token-2022' };
  } catch (err) {
    return null;
  }
}

function metaplexMetadataPda(mint) {
  const mintKey = mint instanceof PublicKey ? mint : new PublicKey(mint);
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('metadata'), METAPLEX_METADATA_PROGRAM.toBuffer(), mintKey.toBuffer()],
    METAPLEX_METADATA_PROGRAM
  );
  return pda;
}

async function readMintMetadata(connection, mint) {
  if (!connection || !mint || typeof connection.getAccountInfo !== 'function') return null;
  let mintInfo = null;
  try {
    mintInfo = await connection.getAccountInfo(new PublicKey(mint), 'confirmed');
  } catch (err) {
    mintInfo = null;
  }
  const embedded = decodeToken2022Metadata(mintInfo, mint);
  if (embedded) return embedded;
  try {
    const metaInfo = await connection.getAccountInfo(metaplexMetadataPda(mint), 'confirmed');
    return decodeMetaplexMetadata(metaInfo && metaInfo.data);
  } catch (err) {
    return null;
  }
}

module.exports = {
  METAPLEX_METADATA_PROGRAM,
  decodeMetaplexMetadata,
  decodeToken2022Metadata,
  metaplexMetadataPda,
  readMintMetadata
};
