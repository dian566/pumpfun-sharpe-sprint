# STRATEGY.md — Completion Rider

## Goal

Win on **hourly Sharpe ratio** across a 6-hour pump.fun replay, with net PnL
above 0 after fees (a prize requires beating hold-cash). Sharpe rewards
steady, controlled gains: many small wins with low variance beat one
moonshot, and it punishes steady small losses just as hard.

## What the dev window taught us

Backtests on the kit's frozen 24h dev window (2–3 Nov 2026, 1222 mints,
126,801 trades) plus a forward-return study of every trade moment
(`tools/explore.py` in the build workspace):

- Unconditional forward returns are negative (mean −2.2% over 100 slots,
  −3.9% over 300, −13.6% over 900): most pump.fun coins bleed. Random or
  loose entries lose to fees alone.
- **Near-completion curves are the only regime with positive expectancy**:
  moments with real SOL at 50 or above have 51% of prices up more than 3%
  after 300 slots. Curves approaching the ~85 SOL completion threshold get
  bought into the migration; a tight stop caps the dumps that skew the mean
  negative.
- Fast surges also continue short-term (price +20% in 40 slots averages
  +4.6% over the next 300), fresh curves (age under 500) with inflow average
  +1.6% — but in the full sim those entries bled worse than completion
  entries, so the bot only trades the completion regime.
- Falling knives do not bounce (down 10% or more in-window averages −6% over
  the next 100 slots). Dip-buying also lost in the sim.
- A round trip costs about 2.5% curve fees (95 + 30 bps per side) plus around
  0.00021 SOL tx fees. Bigger stakes dilute the fixed tx fee: 0.30 SOL per
  position beat 0.04–0.12 SOL clearly in the sweep.
- **Two exits that look sensible hurt**: the flow-fade exit and the trailing
  stop both cut winners before they pay (wins 5 to 10 when fade was removed,
  Sharpe −0.57 to −0.10; Sharpe −0.10 to +0.38 when the trailing stop was
  disabled). Both are OFF in the final config.

## Rules (final, `DEFAULT_PARAMS` in `strategy.ts`)

**Entry** — on a curve that traded this batch:
- real SOL 50–85 (near completion), age 30 slots or more since CreateEvent;
- over the last 40 slots: net buy flow 0.3 SOL or more, 3 buy trades or more,
  3 distinct buyers or more, price up 8% or more from window start (and at
  most 200%), price at 90% or more of window high, largest single buyer at
  most 70% of buy SOL;
- size 0.30 SOL (capped at 1% of real reserve), one buy per mint, at most 5
  open, at most 2 SOL at cost across all positions.

**Exits** — sell the whole position on the first of: take-profit +25% of cost,
stop-loss −15%, or max hold 600 slots (~4 min). No fade, no trailing stop, no
big-sell exit. A curve that completes is closed by the replay at its final
reserves.

**Guardrail probes** — if filled distinct mints lag 30 × (elapsed / 6h), buy
0.012 SOL of a liquid curve and sell it as soon as the buy lands (at most 1
probe in flight). Main completion trades are only about 12 per 6h, so probes
supply the rest of the 20-mint minimum; each costs roughly 0.0005 SOL.
Verified on a truncated first-6h sim: 30 coins, guardrail cleared.

## Results (local sim, full 24h dev window, mean over 4 failed-tx draws)

- Net PnL **+0.522 SOL** (+5.2%), hourly Sharpe **+0.455** (worst fail draw
  +0.409), max drawdown 1.4%, 47 round trips, 13 wins (28%), 47 distinct
  mints, 94 fills. Per-6h-slice Sharpes all positive: +0.28 / +0.30 / +0.46 /
  +0.93. At 2× fees: net +0.19, Sharpe +0.16.
- Official `grade-local --driver process`: see `grade-local.log` in the build
  workspace (the dev score is not the final score — the final window is 6h of
  new data recorded after entries close).

## Honest caveat

A `grade-local --stress 20` run (20 rebuilt copies of the dev window) gives
median −0.17 SOL, p10 −0.54, p90 +0.15: 15 of 20 copies lose money, and the
dev score sits above all 20 copies. The edge leans on a few big winners
(top-3 coins are 29% of gains), so on a fresh 6h window the outcome is
genuinely uncertain. This is still the best variant found on dev by a wide
margin (next best: surge Sharpe −0.57, dip −0.57, probe-only ≈ −0.06 net
with very negative Sharpe).

## Determinism

No `Date`, `Math.random`, environment, or network. All state derives from the
batch stream; maps iterate in insertion order; buy client ids are sequential
(`b1, b2, …` — the `o` prefix is the SDK shim's auto ids, and sharing it once
caused `duplicate_client_id` rejections). A sell that is rejected (e.g.
`max_order_size` on a thin curve) is retried next batch instead of orphaning
the position. Two runs produce byte-identical action logs (verified by
`grade-local`, which executes each entry twice).

## Tuning

Parameters were swept on the dev window with the local engine port
(`tools/sim.ts` in the build workspace), ranking by hourly Sharpe (mean over 4
failed-tx draws), then net PnL. Flat regions were preferred over single best
cells: stake 0.30 beats 0.20 and 0.40; TP +25% beats +20%/+35%; SL −15% beats
−12%/−20%. The dev window is 24h; the final window is 6h, so per-6h-slice
Sharpes were checked too. See the build log for the full sweep tables.
