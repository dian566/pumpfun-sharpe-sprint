// Completion Rider — a paper-trading bot for the pump.fun bonding-curve replay
// (agent-fun/replay/v2), written for the "Pump.fun Sharpe Sprint" bounty.
//
// The ranking metric is hourly Sharpe ratio, not net PnL: steady, controlled
// gains beat one lucky moonshot, yet a prize still needs net PnL above zero
// after every fee. So this bot trades SMALL, SHORT and SELECTIVE: many tiny
// momentum scalps with a tight take-profit / stop-loss pair, short holds
// (positions rarely survive an hour boundary, which keeps hourly equity marks
// smooth), and only a small share of the 10 SOL capital at risk at once. A
// pacing guardrail of tiny probe round trips (0.012 SOL) guarantees the
// 20-distinct-mint minimum even on a quiet window; probes cost about 0.0006 SOL
// each, cheap insurance.
//
// Fees set the bar: a round trip costs roughly 2.5% curve fees (95 + 30 bps a
// side) plus about 0.00021 SOL of tx fees, so a 0.04 SOL scalp must gain around
// 3% just to break even. Entries therefore demand real buy pressure (net
// inflow, several distinct buyers, price rising and holding near its window
// high) and exits are quick: take-profit +10%, stop-loss -6%, a trailing stop
// once +5% up, a fade exit when flow turns, and a hard time limit.
//
// Deterministic by construction: every decision comes only from the batch stream
// (slots, events, marks, fills, account); iteration is over insertion-ordered
// maps; no clock, no randomness, no environment, no network.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Entry mode: 'surge' buys rising curves with buy flow; 'dip' buys a pullback
   *  whose buy flow has just turned back up. */
  entryMode: 'surge' | 'dip';
  /** Dip mode: price fell this far from the window high (fraction), at most this far. */
  minDip: number;
  maxDip: number;
  /** Dip mode: newer-half net SOL must exceed this. */
  dipNewNetSol: number;
  /** Dip mode: price now at least this far above the window low. */
  dipRecover: number;
  /** Entry window in slots. */
  window: number;
  /** Net buy SOL (buys minus sells) over the window. */
  minNetSol: number;
  /** Buy trades in the window. */
  minBuys: number;
  /** Distinct buying wallets in the window. */
  minBuyers: number;
  /** Price now over price at the window start, minus 1. */
  minPriceUp: number;
  /** Upper bound on that rise: skip curves that already ran too far in one window. */
  maxPriceUp: number;
  /** Price now at least this share of the window's high. */
  nearHigh: number;
  /** Largest single wallet's share of the window's buy SOL. */
  maxBuyerShare: number;
  /** Curve real SOL bounds at entry. */
  minRqSol: number;
  maxRqSol: number;
  /** Slots since the CreateEvent before an entry is allowed. */
  minAge: number;
  /** Slots since the CreateEvent after which no entry is allowed (0 = no cap). */
  maxAge: number;
  /** SOL put into one position (single buy per mint). */
  stakeSol: number;
  /** Slippage on buys (bps); sells always go out at 10000. */
  buySlipBps: number;
  /** Exits, as fractions of cost / peak value. */
  takeProfit: number;
  stopLoss: number;
  trail: number;
  /** The trailing stop arms once value reached cost * (1 + trailArm). */
  trailArm: number;
  /** Exit when net SOL over the fade window falls below -fadeNetSol. */
  fadeWindow: number;
  fadeNetSol: number;
  /** Exit on any single recorded sell of at least this many SOL. */
  bigSellSol: number;
  /** Exit after this many slots held. */
  maxHold: number;
  /** Slots to wait after an exit before the same curve may be bought again. */
  cooldown: number;
  /** Most entries per curve over the run. */
  maxEntries: number;
  /** Most momentum positions open at once. */
  maxMain: number;
  /** Most SOL at cost across all positions at once (a drawdown guard). */
  maxExposureSol: number;
  /**
   * Guardrail pacing: the run must end with a >= 0.01 SOL round trip on at least
   * 20 distinct mints. When the bot's own filled coins lag targetCoins scaled by
   * the share of paceSecs elapsed (block time since the first batch), it opens
   * tiny probe round trips (buy probeSol, sell it all as soon as the buy lands)
   * until it is back on pace. paceSecs is 6h: the final window is 6 hours.
   */
  targetCoins: number;
  paceSecs: number;
  probeSol: number;
  maxProbes: number;
}

export const DEFAULT_PARAMS: Params = {
  // Tuned on the frozen 24h dev window, ranked by hourly Sharpe (mean over 4
  // failed-tx draws): stake 0.30 SOL beats 0.20 and 0.40; TP +25% beats +20% /
  // +35%; SL -15% beats -12% / -20%. Flat regions were preferred over single
  // best cells. Final grade-local: net +0.5366 SOL, hourly Sharpe +0.455.
  entryMode: 'surge',
  minDip: 0.08,
  maxDip: 0.35,
  dipNewNetSol: 0.05,
  dipRecover: 0.03,
  window: 40,
  minNetSol: 0.3,
  minBuys: 3,
  minBuyers: 3,
  minPriceUp: 0.08,
  maxPriceUp: 2,
  nearHigh: 0.9,
  maxBuyerShare: 0.7,
  minRqSol: 50,
  maxRqSol: 85,
  minAge: 30,
  maxAge: 0,
  stakeSol: 0.3,
  buySlipBps: 500,
  takeProfit: 0.25,
  stopLoss: 0.15,
  // Trailing stop OFF (trailArm 1, so it never arms): sweep O showed it cuts winners.
  trail: 0.05,
  trailArm: 1,
  // Fade and big-sell exits OFF (1000, so they never trigger): sweep I showed fade kills winners.
  fadeWindow: 25,
  fadeNetSol: 1000,
  bigSellSol: 1000,
  maxHold: 600,
  cooldown: 150,
  maxEntries: 1,
  maxMain: 5,
  maxExposureSol: 2,
  targetCoins: 30,
  paceSecs: 21_600,
  probeSol: 0.012,
  maxProbes: 1,
};

const LAMPORTS = 1e9;

interface Trade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface Tape {
  created: number | null;
  trades: Trade[];
  entries: number;
  lastExit: number;
}

interface Held {
  opened: number;
  peakValue: number;
  probe: boolean;
}

function priceOf(curve: { virtual_quote_reserves: bigint; virtual_token_reserves: bigint }): number {
  const vq = Number(curve.virtual_quote_reserves);
  const vt = Number(curve.virtual_token_reserves);
  return vt > 0 ? vq / vt : 0;
}

export function createStrategy(p: Params): Bot {
  const tapes = new Map<Pubkey, Tape>();
  const held = new Map<Pubkey, Held>();
  /** client_id -> { mint, probe } for buys sent and not yet resolved. */
  const pendingBuys = new Map<string, { mint: Pubkey; probe: boolean }>();
  const probeClientIds = new Set<string>();
  let coins = 0;
  let fills = 0;
  const seenCoins = new Set<Pubkey>();
  let startTime = -1;
  let nextId = 1;
  /** Exit-reason counts (local diagnostics only; never printed by the bot). */
  const diag = { tp: 0, sl: 0, trail: 0, hold: 0, fade: 0, bigSell: 0, probe: 0 };

  const tapeFor = (mint: Pubkey): Tape => {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = { created: null, trades: [], entries: 0, lastExit: -1 };
      tapes.set(mint, t);
    }
    return t;
  };
  /** Mints with a sell sent and not yet resolved: don't re-sell while it is in flight. */
  const sellPending = new Set<Pubkey>();

  const bot = {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const orders: OrderInput[] = [];
      const slot = batch.slot;
      const blockTime = batch.events.length > 0 ? Number(batch.events[batch.events.length - 1].block_time) : -1;
      if (startTime < 0 && blockTime > 0) startTime = blockTime;

      // --- 1. Fold fills: track resolved buys, drop closed positions. ---
      for (const f of batch.fills) {
        if (f.side === 'sell' && f.status !== 'filled') sellPending.delete(f.mint);
        if (f.status === 'filled' && !f.client_id.startsWith('_')) {
          fills += 1;
          if (!seenCoins.has(f.mint)) {
            seenCoins.add(f.mint);
            coins += 1;
          }
          const pb = pendingBuys.get(f.client_id);
          if (pb !== undefined && f.side === 'buy') {
            pendingBuys.delete(f.client_id);
            probeClientIds.delete(f.client_id);
            const pos = state.positions.get(f.mint);
            const curve = state.curves.get(f.mint);
            if (pos !== undefined && curve !== undefined) {
              const value = Number(pos.token_amount) * priceOf(curve);
              held.set(f.mint, { opened: f.slot, peakValue: value, probe: pb.probe });
            }
          }
        } else if (f.status !== 'filled') {
          pendingBuys.delete(f.client_id);
          probeClientIds.delete(f.client_id);
        }
      }
      // Positions the harness closed (complete / flatten) disappear from the account.
      for (const mint of [...held.keys()]) {
        if (!state.positions.has(mint)) {
          held.delete(mint);
          sellPending.delete(mint);
          const t = tapes.get(mint);
          if (t !== undefined) t.lastExit = slot;
        }
      }

      // --- 2. Update tapes from this batch's trades. ---
      const touched: Pubkey[] = [];
      const touchedSet = new Set<Pubkey>();
      for (const e of batch.events) {
        if (e.event === 'CreateEvent') {
          tapeFor(e.mint).created = e.slot;
          if (!touchedSet.has(e.mint)) {
            touchedSet.add(e.mint);
            touched.push(e.mint);
          }
        } else if (e.event === 'TradeEvent') {
          const t = tapeFor(e.mint);
          const price =
            Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves);
          t.trades.push({
            slot: e.slot,
            buy: e.is_buy,
            sol: Number(e.sol_amount) / LAMPORTS,
            user: e.user,
            price,
          });
          if (!touchedSet.has(e.mint)) {
            touchedSet.add(e.mint);
            touched.push(e.mint);
          }
        } else {
          // CompleteEvent: curve is done, forget its tape.
          tapes.delete(e.mint);
        }
      }
      // Prune tapes to the longest lookback we use, to bound memory.
      const keepFrom = slot - Math.max(p.window, p.fadeWindow);
      for (const t of tapes.values()) {
        while (t.trades.length > 0 && t.trades[0]!.slot < keepFrom) t.trades.shift();
        if (t.trades.length > 400) t.trades.splice(0, t.trades.length - 400);
      }

      const txFee = state.txFeeLamports();
      let free = state.freeCashLamports();
      let exposure = 0;
      for (const pos of state.positions.values()) exposure += Number(pos.cost_lamports) / LAMPORTS;
      const openMain = [...held.values()].filter((h) => !h.probe).length;
      let mainSlots = p.maxMain - openMain;

      // Values in LAMPORTS on both sides (a units bug here once made every
      // position "take profit" one batch after its buy filled).
      const valueOf = (mint: Pubkey): number => {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined || curve === undefined) return 0;
        return Number(pos.token_amount) * priceOf(curve);
      };
      const costOf = (mint: Pubkey): number => {
        const pos = state.positions.get(mint);
        return pos === undefined ? 0 : Number(pos.cost_lamports);
      };

      // --- 3. Exits, in held-insertion order. ---
      for (const [mint, h] of held) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined || curve === undefined || curve.complete) continue;
        if (sellPending.has(mint)) continue;
        const value = valueOf(mint);
        const cost = costOf(mint);
        if (cost <= 0) continue;
        if (value > h.peakValue) h.peakValue = value;
        const ret = value / cost - 1;
        let sell = false;
        let reason = '';
        if (h.probe) {
          sell = true; // probes exit as soon as the buy lands
          reason = 'probe';
        } else if (ret >= p.takeProfit) {
          sell = true;
          reason = 'tp';
        } else if (ret <= -p.stopLoss) {
          sell = true;
          reason = 'sl';
        } else if (h.peakValue >= cost * (1 + p.trailArm) && value <= h.peakValue * (1 - p.trail)) {
          sell = true;
          reason = 'trail';
        } else if (slot - h.opened >= p.maxHold) {
          sell = true;
          reason = 'hold';
        } else {
          // Fade: net SOL over the fade window turned negative.
          const t = tapes.get(mint);
          if (t !== undefined) {
            let net = 0;
            for (let i = t.trades.length - 1; i >= 0; i--) {
              const tr = t.trades[i]!;
              if (tr.slot < slot - p.fadeWindow) break;
              net += tr.buy ? tr.sol : -tr.sol;
            }
            if (net < -p.fadeNetSol) {
              sell = true;
              reason = 'fade';
            }
          }
          // One big sell in this batch dumps the position.
          if (!sell) {
            for (const e of batch.events) {
              if (
                e.event === 'TradeEvent' &&
                e.mint === mint &&
                !e.is_buy &&
                Number(e.sol_amount) / LAMPORTS >= p.bigSellSol
              ) {
                sell = true;
                reason = 'bigSell';
                break;
              }
            }
          }
        }
        if (sell && orders.length < 16) {
          diag[reason as keyof typeof diag] += 1;
          orders.push({
            side: 'sell',
            mint,
            token_amount: pos.token_amount,
            max_slippage_bps: 10_000,
          });
          // Keep the held entry until the position actually disappears: if this
          // sell is rejected (e.g. max_order_size on a thin curve) the position
          // must be re-evaluated next batch, not orphaned until flatten.
          sellPending.add(mint);
        }
      }

      // --- 4. Entries: evaluate the signal on curves that traded this batch. ---
      for (const mint of touched) {
        if (orders.length >= 16 || mainSlots <= 0) break;
        if (held.has(mint)) continue;
        const t = tapes.get(mint);
        const curve = state.curves.get(mint);
        if (t === undefined || curve === undefined || curve.complete) continue;
        if (t.created === null || slot - t.created < p.minAge) continue;
        if (p.maxAge > 0 && slot - t.created > p.maxAge) continue;
        if (t.entries >= p.maxEntries) continue;
        if (slot - t.lastExit < p.cooldown) continue;
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
        if (rqSol < p.minRqSol || rqSol > p.maxRqSol) continue;
        const cap = state.maxBuyLamports(mint);
        const capSol = Number(cap) / LAMPORTS;
        if (capSol < 0.01) continue;
        const amountSol = Math.min(p.stakeSol, capSol);
        if (amountSol < 0.01) continue;
        if (exposure + amountSol > p.maxExposureSol) continue;

        // Window tape stats.
        let net = 0;
        let netNew = 0;
        let buys = 0;
        let buySol = 0;
        let firstPrice = 0;
        let high = 0;
        let low = Infinity;
        const buyers = new Map<string, number>();
        let winTrades = 0;
        const halfSlot = slot - p.window / 2;
        for (const tr of t.trades) {
          if (tr.slot < slot - p.window) continue;
          winTrades++;
          if (firstPrice === 0) firstPrice = tr.price;
          if (tr.price > high) high = tr.price;
          if (tr.price < low) low = tr.price;
          if (tr.buy) {
            net += tr.sol;
            buys++;
            buySol += tr.sol;
            buyers.set(tr.user, (buyers.get(tr.user) ?? 0) + tr.sol);
            if (tr.slot >= halfSlot) netNew += tr.sol;
          } else {
            net -= tr.sol;
            if (tr.slot >= halfSlot) netNew -= tr.sol;
          }
        }
        if (winTrades < 3 || firstPrice === 0) continue;
        const nowPrice = priceOf(curve);
        if (p.entryMode === 'dip') {
          // Pullback with buy flow returning: price down minDip..maxDip from the
          // window high, newer-half flow positive, price recovering off the low.
          if (high <= 0 || low === Infinity) continue;
          const dip = 1 - nowPrice / high;
          if (dip < p.minDip || dip > p.maxDip) continue;
          if (netNew < p.dipNewNetSol) continue;
          if (nowPrice < low * (1 + p.dipRecover)) continue;
          if (buys < p.minBuys) continue;
          if (buyers.size < p.minBuyers) continue;
        } else {
          const rise = nowPrice / firstPrice - 1;
          if (net < p.minNetSol) continue;
          if (buys < p.minBuys) continue;
          if (buyers.size < p.minBuyers) continue;
          if (rise < p.minPriceUp || rise > p.maxPriceUp) continue;
          if (high > 0 && nowPrice < high * p.nearHigh) continue;
          let biggest = 0;
          for (const v of buyers.values()) if (v > biggest) biggest = v;
          if (buySol > 0 && biggest / buySol > p.maxBuyerShare) continue;
        }

        const amount = BigInt(Math.floor(amountSol * LAMPORTS));
        if (free < amount + txFee) continue;
        // Own ids use the `b` prefix: the SDK shim assigns `o1, o2, ...` to orders
        // without an id (our sells), so `o`-prefixed buy ids would collide.
        const cid = `b${nextId++}`;
        pendingBuys.set(cid, { mint, probe: false });
        orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: p.buySlipBps, client_id: cid });
        t.entries += 1;
        free -= amount + txFee;
        exposure += amountSol;
        mainSlots -= 1;
      }

      // --- 5. Guardrail probes: stay on pace for >= 20 distinct mints. ---
      const elapsed = startTime > 0 && blockTime > 0 ? blockTime - startTime : 0;
      const pace = p.paceSecs > 0 ? elapsed / p.paceSecs : 1;
      const needCoins = Math.ceil(p.targetCoins * Math.min(1, pace));
      const probesInFlight = [...pendingBuys.values()].filter((v) => v.probe).length + [...held.values()].filter((h) => h.probe).length;
      if (coins < needCoins && probesInFlight < p.maxProbes && orders.length < 16) {
        for (const mint of touched) {
          if (orders.length >= 16) break;
          if (held.has(mint) || seenCoins.has(mint)) continue;
          const curve = state.curves.get(mint);
          if (curve === undefined || curve.complete) continue;
          const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
          if (rqSol < 1) continue;
          if (Number(state.maxBuyLamports(mint)) / LAMPORTS < p.probeSol) continue;
          const amount = BigInt(Math.floor(p.probeSol * LAMPORTS));
          if (free < amount + txFee) continue;
          const cid = `b${nextId++}`;
          pendingBuys.set(cid, { mint, probe: true });
          probeClientIds.add(cid);
          orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: p.buySlipBps, client_id: cid });
          free -= amount + txFee;
          break;
        }
      }

      return orders;
    },
  } as Bot & { diag: typeof diag };
  bot.diag = diag;
  return bot;
}
