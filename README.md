# Kamino Health Scanner

A read-only scanner for [Kamino Lend](https://kamino.finance) on Solana. It downloads every borrowing position in a
market, computes each position's health with Kamino's own SDK, and shows how close the market is to liquidations:

- positions and debt by health bucket
- the positions closest to liquidation, with their collateral and debt assets
- **price-shock scenarios**: how much debt becomes liquidatable if every non-stablecoin asset drops 5%, 10%, 20%…
- a CSV file with every position, for your own analysis

It holds no keys, signs nothing and sends nothing. It works on the free public Solana RPC.

## Read this before you build a liquidation bot

We built these tools while trying, for more than two years, to run a profitable Solana liquidation bot on free and
low-cost infrastructure: public RPC, free API tiers, a home connection and later a small VPS. **We never found
evidence that it can be done.** This is not a mathematical proof that it is impossible, but it is what our own
measurements showed, and we are publishing it so that others don't spend years finding out the same way.

What the data showed:

- **We lost every race.** On Kamino, 64 real liquidation attempts between 2026-10-22 and 2026-11-05 all landed on
  chain and all failed: each landed 1 to 12 slots after the winning bot, when the position was already liquidated.
  Every attempt still paid fees and tips.
- **The winners land in the same slot as the price change.** About two thirds of winning Kamino liquidations refresh
  the oracle price inside their own transaction, so by the time a public feed shows the position as liquidatable,
  the liquidation is often already done.
- **Public data feeds are too slow.** The public WebSocket delivered price updates a median of 170 to 190 ms after a
  dedicated feed (Yellowstone gRPC or a paid RPC), about half a slot.
- **The market is concentrated.** In one month of Kamino data (1,763 liquidations), 69 wallets did all of it and the
  top two did 39%.
- **Most opportunities are too small to pay for themselves.** In a two-week study of 4,217 liquidations on another
  Solana lending protocol, our real cost per attempt was about $0.15, so a liquidation had to seize about $3 just to
  break even. Only 41 of the 4,217 did.

What the winners appear to have that public infrastructure does not: dedicated low-latency data feeds (gRPC or
shredstream), servers next to the validators and block engines, staked or priority transaction routes, their own
capital instead of flash loans, and enough volume to absorb the losing attempts.

If you are starting out, measure before you invest: run `feed-race.js` and `land-bench.js` from [solana-latency-toolkit](https://github.com/emilutica1/solana-latency-toolkit) on the machine you plan
to use and compare the slot numbers with the winners' landing slots. If you are one or more slots behind, faster
code will not close the gap; only infrastructure will.
## Install and run

Requires Node.js 20 or newer.

```bash
git clone https://github.com/emilutica1/kamino-health-scanner
cd kamino-health-scanner
npm install
node scan.js --market jlp --shock -5,-10
```

| Option | Default | Meaning |
|---|---|---|
| `--market` | `main` | `main`, `jlp`, `xstocks` or any Kamino Lend market address |
| `--shock` | none | comma-separated price moves in %, applied to every non-stablecoin asset, e.g. `-5,-10,-20` |
| `--top` | `25` | how many of the closest positions to list |
| `--min-debt` | `100` | only list positions with at least this much debt (USD) |
| `RPC_HTTP` (env) | public mainnet | RPC endpoint; it must allow `getProgramAccounts` |
| `PACE_MS` (env) | `250` | pause between the 256 download pages; raise it if you get rate-limited |
| `DATA_DIR` (env) | `./data` | where the CSV is written |

A full scan of the JLP market takes about 6 minutes on the public RPC; the Main market takes longer. A private RPC
endpoint is much faster.

## Example output

JLP market, 2026-11-07 19:59 UTC:

```
3816 positions with debt, total debt $21.85M

health ratio (1.00 = liquidatable)   positions        debt
  ≥ 1.00  liquidatable now                  0       $0.00
  0.95 – 1.00                              37     $342.9K
  0.90 – 0.95                              41      $1.80M
  0.80 – 0.90                             118      $5.16M
  < 0.80                                 3620     $14.55M

closest to liquidation (debt ≥ $100):
  ratio    debt        collateral  position                                       collateral → debt
  0.9916  $8.4K       $10.0K      4XsCgsFSRc1ETm6gjC6actpFwMkMp72redbaGNqcGANW   JLP → USDC
  0.9901  $1.3K       $1.5K       B3habUu9mv6wmdBvmbFH4XtNUgwKPasd2RXmwVw7YVv3   JLP+PYUSD → USDT
  …

price shock (all non-stablecoin assets)   liquidatable positions        debt
  -5%                                             37        $342.9K
  -10%                                            78         $2.14M
```

Main market, 2026-11-07 20:06 UTC (57,504 positions, $399.76M of debt), with `--shock -5,-10,-20`:

```
health ratio (1.00 = liquidatable)   positions        debt
  ≥ 1.00  liquidatable now                  0       $0.00
  0.95 – 1.00                            2140    $111.67M
  0.90 – 0.95                            2499     $65.81M
  0.80 – 0.90                           15919     $88.50M
  < 0.80                                36946    $133.78M

price shock (all non-stablecoin assets)   liquidatable positions        debt
  -5%                                            306         $3.23M
  -10%                                           475        $11.10M
  -20%                                           991        $71.75M
```

Many of the positions closest to liquidation in the Main market are stablecoin-to-stablecoin loans (for example USDT
collateral against USDC debt) that are pushed toward the line by interest and small stablecoin price differences, not by market moves.

We cross-checked the scanner against our own continuously running monitor: for the same positions the health ratios
agreed to within 0.0001.

## How it works

1. **Load the market** with `@kamino-finance/klend-sdk`: reserves, their configuration and their current oracle prices.
2. **Download every obligation** of the market with `getProgramAccounts` (account size 3344, market filter), split into 256
   pages by the first byte of the owner address so that each response stays small enough for public RPCs.
3. **Skip positions without debt.** Careful: the stored debt value (`borrowedAssetsMarketValueSf`) is only updated when
   the obligation is refreshed, so a position that borrowed after its last refresh shows 0 there. The scanner also
   checks each borrow slot's raw borrowed amount; checking only the stored value misses those positions. In one check
   of the Main market, about 1,460 positions with $15.9M of debt were affected.
4. **Compute health** with the SDK (`KaminoObligation`): ratio = loan-to-value ÷ liquidation loan-to-value, including
   accrued interest up to the current slot. At 1.00 or more, the position can be liquidated.
5. **Shock scenarios** multiply every non-stablecoin reserve price by (1 + X%), recompute every position, and restore
   the prices.

## Limitations

- Prices are the last prices written on chain. Kamino's oracle (Scope) is refreshed continuously, and liquidators
  usually refresh it inside their own transaction, so the live state can be slightly ahead of what the scanner sees.
- A shock moves all non-stablecoin assets together; real markets don't move in lockstep, and correlated pairs (for
  example SOL collateral with a SOL-based debt) are only approximated.
- One scan is one snapshot. For continuous monitoring, run it on a schedule or subscribe to account changes.

## Related

- [kamino-liquidation-tracker](https://github.com/emilutica1/kamino-liquidation-tracker): records every Kamino
  liquidation as it happens, and who did it.
- [solana-latency-toolkit](https://github.com/emilutica1/solana-latency-toolkit): fastest data feed, slots-to-land per
  send route, endpoint round-trip times.

## Credits

Built by [emilutica1](https://github.com/emilutica1) and Claude, Anthropic's AI model, working together through
[Claude Code](https://claude.com/claude-code). Issues and pull requests are welcome.

## License

MIT. See [LICENSE](LICENSE).
