// Kamino Lend health scanner — read-only, holds no keys, signs and sends nothing.
//
// Downloads every borrowing position (obligation) in a Kamino Lend market, computes its health with Kamino's own SDK
// at the market's current on-chain prices, and reports how close the market is to liquidations:
//   - positions and debt by health bucket (ratio = loan-to-value / liquidation loan-to-value; ≥ 1 means liquidatable)
//   - the positions closest to liquidation
//   - optional price-shock scenarios: what crosses the line if every non-stablecoin asset moved by X%
// Writes every position to a CSV file for your own analysis.
//
// Usage: node scan.js [--market main|jlp|xstocks|<address>] [--shock -5,-10,-20] [--top 25] [--min-debt 100]
//        RPC_HTTP=<url> node scan.js …   (default: public mainnet RPC)
'use strict';
const fs = require('fs');
const path = require('path');
const bs58 = require('bs58');
const Decimal = require('decimal.js');
const { Connection, PublicKey } = require('@solana/web3.js');
const { createSolanaRpc, address } = require('@solana/kit');
const klend = require('@kamino-finance/klend-sdk');

const arg = (name, def) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : def; };
const MARKETS = {
  main: '7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF',
  jlp: 'DxXdAyU3kCjnyggvHmY5nAwg5cRbbmdyX3npfDMjjMek',
  xstocks: '5wJeMrUYECGq41fxRESKALVcHnNX26TAWy4W98yULsua',
};
const MARKET = MARKETS[String(arg('market', 'main')).toLowerCase()] || arg('market');
const SHOCKS = String(arg('shock', '')).split(',').filter(Boolean).map(Number);
const TOP = Number(arg('top', 25));
const MIN_DEBT = Number(arg('min-debt', 100));
const RPC_HTTP = process.env.RPC_HTTP || 'https://api.mainnet-beta.solana.com';
const PACE_MS = Number(process.env.PACE_MS || 250);    // pause between the 256 download pages; raise it if you get 429s
const OUT_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));

const KLEND = new PublicKey('KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD');
const OBLIGATION_SIZE = 3344;
// Debt check on raw account data. The stored debt value (borrowedAssetsMarketValueSf) is only updated when the
// obligation is refreshed, so a position that borrowed after its last refresh shows 0 there. Also check each of the
// 5 borrow slots' borrowedAmountSf, or such positions are silently missed.
const DEBT_OFFSET = 2224, BORROWS_OFFSET = 1208, BORROW_ENTRY = 200, BORROW_AMOUNT_AT = 88, MAX_BORROWS = 5;
const nonZero128 = (b, o) => (b.readBigUInt64LE(o) | b.readBigUInt64LE(o + 8)) !== 0n;
const hasDebt = (b) => nonZero128(b, DEBT_OFFSET) || Array.from({ length: MAX_BORROWS }, (_, i) => BORROWS_OFFSET + BORROW_ENTRY * i + BORROW_AMOUNT_AT).some((o) => nonZero128(b, o));
const STABLE = /^(USDC|USDT|PYUSD|USDS|USDG|FDUSD|USDH|USD1|CASH|UXD|DAI|EURC|AUSD|USDe|sUSDe|USDY|USDu|USX|UST|CHAI)$/i;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function retry(fn, tries = 6) {
  for (let a = 0; ; a++) { try { return await fn(); } catch (e) { if (a >= tries - 1) throw e; await sleep(2000 * (a + 1)); } }
}
const usd = (x) => (x >= 1e6 ? `$${(x / 1e6).toFixed(2)}M` : x >= 1e3 ? `$${(x / 1e3).toFixed(1)}K` : `$${x.toFixed(2)}`);

(async () => {
  if (!MARKET) throw new Error('unknown --market');
  const rpc = createSolanaRpc(RPC_HTTP);
  const conn = new Connection(RPC_HTTP, { commitment: 'confirmed', disableRetryOnRateLimit: true });
  console.error(`loading market ${MARKET}…`);
  const market = await retry(() => klend.KaminoMarket.load(rpc, address(MARKET), 400));
  const slot = Number(await retry(() => rpc.getSlot().send()));
  const ledger = { slot: BigInt(slot), blockTime: BigInt(Math.floor(Date.now() / 1000)) };
  const sym = (a) => market.reserves.get(address(String(a)))?.symbol ?? String(a).slice(0, 6);

  // 1) download: 256 pages, split by the first byte of the owner address so each response stays small
  const raw = [];
  const t0 = Date.now();
  for (let b = 0; b < 256; b++) {
    const res = await retry(() => conn.getProgramAccounts(KLEND, { filters: [{ dataSize: OBLIGATION_SIZE },
      { memcmp: { offset: 32, bytes: MARKET } }, { memcmp: { offset: 64, bytes: bs58.encode(Buffer.from([b])) } }] }));
    for (const a of res) if (hasDebt(a.account.data)) raw.push([a.pubkey.toBase58(), a.account.data]);
    if (b % 32 === 31) console.error(`  downloaded ${b + 1}/256 pages, ${raw.length} positions with debt`);
    await sleep(PACE_MS);
  }
  console.error(`download done in ${((Date.now() - t0) / 1000).toFixed(0)} s`);

  // 2) health with the SDK, at the market's current on-chain prices
  const health = (addr, d) => {
    const r = klend.KaminoObligation.getRatesForObligation(market, d.deposits, d.borrows, ledger);
    const ob = new klend.KaminoObligation(market, address(addr), d, r.collateralExchangeRates, r.cumulativeBorrowRates);
    const liqLtv = Number(ob.liquidationLtv());
    return { ob, ratio: liqLtv > 0 ? Number(ob.loanToValue()) / liqLtv : null };
  };
  const rows = [];
  let errors = 0, noRatio = 0;
  for (const [addr, buf] of raw) {
    try {
      const d = klend.Obligation.decode(buf);
      const { ob, ratio } = health(addr, d);
      if (ratio === null) { noRatio++; continue; }   // no liquidation LTV, e.g. debt with no collateral left
      rows.push({ addr, d, ratio, debt: Number(ob.refreshedStats.userTotalBorrow), coll: Number(ob.refreshedStats.userTotalDeposit),
        deposits: d.deposits.filter((x) => x.depositedAmount.toString() !== '0').map((x) => sym(x.depositReserve)),
        borrows: d.borrows.filter((x) => x.borrowedAmountSf.toString() !== '0').map((x) => sym(x.borrowReserve)) });
    } catch { errors++; }
  }

  // 3) report
  const total = rows.reduce((s, r) => s + r.debt, 0);
  console.log(`\nKamino market ${MARKET} at slot ${slot} (${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC)`);
  console.log(`${rows.length} positions with debt, total debt ${usd(total)}${noRatio ? `; ${noRatio} more with debt but no health ratio (no collateral counted)` : ''}${errors ? `; ${errors} could not be decoded` : ''}`);
  console.log('\nhealth ratio (1.00 = liquidatable)   positions        debt');
  const buckets = [[1, Infinity, '≥ 1.00  liquidatable now'], [0.95, 1, '0.95 – 1.00'], [0.9, 0.95, '0.90 – 0.95'], [0.8, 0.9, '0.80 – 0.90'], [0, 0.8, '< 0.80']];
  for (const [lo, hi, label] of buckets) {
    const b = rows.filter((r) => r.ratio >= lo && r.ratio < hi);
    console.log(`  ${label.padEnd(33)} ${String(b.length).padStart(9)} ${usd(b.reduce((s, r) => s + r.debt, 0)).padStart(11)}`);
  }
  const close = rows.filter((r) => r.debt >= MIN_DEBT).sort((a, b) => b.ratio - a.ratio).slice(0, TOP);
  console.log(`\nclosest to liquidation (debt ≥ $${MIN_DEBT}):`);
  console.log('  ratio    debt        collateral  position                                       collateral → debt');
  for (const r of close) {
    console.log(`  ${r.ratio.toFixed(4)}  ${usd(r.debt).padEnd(10)}  ${usd(r.coll).padEnd(10)}  ${r.addr.padEnd(45)}  ${r.deposits.join('+')} → ${r.borrows.join('+')}`);
  }

  // 4) shock scenarios: every non-stablecoin reserve price × (1 + pct/100), recomputed, then restored
  if (SHOCKS.length) console.log('\nprice shock (all non-stablecoin assets)   liquidatable positions        debt');
  for (const pct of SHOCKS) {
    const saved = [];
    for (const r of market.reserves.values()) {
      if (STABLE.test(r.symbol)) continue;
      saved.push([r, r.tokenOraclePrice.price]);
      r.tokenOraclePrice.price = r.tokenOraclePrice.price.mul(new Decimal(1 + pct / 100));
    }
    let n = 0, debt = 0;
    try {
      for (const r of rows) { try { const { ratio } = health(r.addr, r.d); if (ratio !== null && ratio >= 1) { n++; debt += r.debt; } } catch {} }
    } finally { for (const [r, p] of saved) r.tokenOraclePrice.price = p; }
    console.log(`  ${((pct > 0 ? '+' : '') + pct + '%').padEnd(40)} ${String(n).padStart(9)} ${usd(debt).padStart(14)}`);
  }

  // 5) CSV
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, `scan-${MARKET.slice(0, 8)}-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`);
  fs.writeFileSync(file, 'position,owner,ratio,debt_usd,collateral_usd,deposits,borrows\n' + rows.sort((a, b) => b.ratio - a.ratio)
    .map((r) => [r.addr, String(r.d.owner), r.ratio.toFixed(6), r.debt.toFixed(2), r.coll.toFixed(2), r.deposits.join('+'), r.borrows.join('+')].join(',')).join('\n') + '\n');
  console.log(`\nall ${rows.length} positions written to ${path.relative(process.cwd(), file)}`);
  console.log('Prices are the market\'s last on-chain oracle prices; a position also becomes liquidatable through interest accrual or a price refresh inside a liquidator\'s own transaction.');
  process.exit(0);
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
