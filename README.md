# Completion Rider — Pump.fun Sharpe Sprint

[![Bounty](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![Rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/dian566/pumpfun-sharpe-sprint/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![Reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/dian566/pumpfun-sharpe-sprint/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

A paper-trading entry for the make.fun bounty
**"Pump.fun Sharpe Sprint — Cleanest Paper Bot Wins"**
(`u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532`).

The entry trades 10 SOL of paper money across a 6-hour pump.fun
bonding-curve replay. Places are decided by **hourly Sharpe ratio**
(highest first); a prize additionally needs net PnL above 0 after every
fee. The guardrails: at most 5 open positions, a round trip of at least
0.01 SOL on at least 20 distinct mints, and maximum drawdown of 50%.

## How it trades

Small, short, selective momentum scalps (full write-up in `STRATEGY.md`):
buy fresh curves whose price is surging on genuine buy flow, then exit
quickly on take-profit, stop-loss, a trailing stop, flow fade, or a hard
time limit. A pacing guardrail of tiny 0.012 SOL probe round trips makes
sure the 20-mint minimum is met. Fully deterministic: no clock, no
randomness, no network, no environment — every decision comes only from
the batch stream, so two runs produce byte-identical action logs.

## Contents

- `main.ts` — entrypoint (the grader runs `node /bot/main.ts`, Node 22).
- `strategy.ts` — the strategy (parameters plus `createStrategy`).
- `vendor/makefun-bot.ts` — the kit's SDK shim, vendored byte for byte.
- `STRATEGY.md` — the full strategy write-up and tuning notes.
- `LICENSE` — MIT.

## Grade locally

With the bounty kit unpacked (it ships `cli/makefun.mjs` plus the frozen
dev dataset):

```sh
node cli/makefun.mjs grade-local --kit . --bot <repo> --driver process --commit <sha>
```

Verified on the frozen dev dataset (official `grade-local`, process
driver): net PnL **+0.5366 SOL** (+5.37%), hourly Sharpe **+0.455**, max
drawdown 1.37%, 96 fills over 47 coins / 48 round trips, win rate 31.25%,
90% interval +0.045..+1.036 SOL. An L1 regrade reproduced the action log
byte for byte, confirming determinism.

## License

MIT — see `LICENSE`.
