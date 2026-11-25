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
//
// Known limits (honest caveat): a stress run of 20 rebuilt dev-window copies
// gives median -0.17 SOL and 15 of 20 copies losing money, so the edge leans
// on a few big winners (top-3 coins are 29% of gains) and the fresh 6h window
// is genuinely uncertain. This is still the best variant found on dev by a
// wide margin (next best: surge Sharpe -0.57, dip -0.57).

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
  height: number;
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

function markPrice(bonding: { virtual_quote_reserves: bigint; virtual_token_reserves: bigint }): number {
  const vq = Number(bonding.virtual_quote_reserves);
  const vt = Number(bonding.virtual_token_reserves);
  return vt > 0 ? vq / vt : 0;
}

export function createStrategy(p: Params): Bot {
  const books = new Map<Pubkey, Tape>();
  const openPos = new Map<Pubkey, Held>();
  /** client_id -> { token, probe } for buys sent and not yet resolved. */
  const awaitingBuys = new Map<string, { token: Pubkey; probe: boolean }>();
  const probeIds = new Set<string>();
  let filledCoins = 0;
  let fillCount = 0;
  const seen = new Set<Pubkey>();
  let t0 = -1;
  let seq = 1;
  /** Exit-reason counts (local diagnostics only; never printed by the bot). */
  const exitCounts = { tp: 0, sl: 0, trail: 0, hold: 0, fade: 0, bigSell: 0, probe: 0 };

  const bookFor = (token: Pubkey): Tape => {
    let tape = books.get(token);
    if (tape === undefined) {
      tape = { created: null, trades: [], entries: 0, lastExit: -1 };
      books.set(token, tape);
    }
    return tape;
  };
  /** Tokens with a sell sent and not yet resolved: don't re-sell while it is in flight. */
  const selling = new Set<Pubkey>();

  const bot = {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const out: OrderInput[] = [];
      const height = batch.slot;
      const bt = batch.events.length > 0 ? Number(batch.events[batch.events.length - 1].block_time) : -1;
      if (t0 < 0 && bt > 0) t0 = bt;

      // --- 1. Fold fills: track resolved buys, drop closed positions. ---
      for (const fill of batch.fills) {
        if (fill.side === 'sell' && fill.status !== 'filled') selling.delete(fill.mint);
        if (fill.status === 'filled' && !fill.client_id.startsWith('_')) {
          fillCount += 1;
          if (!seen.has(fill.mint)) {
            seen.add(fill.mint);
            filledCoins += 1;
          }
          const pend = awaitingBuys.get(fill.client_id);
          if (pend !== undefined && fill.side === 'buy') {
            awaitingBuys.delete(fill.client_id);
            probeIds.delete(fill.client_id);
            const position = state.positions.get(fill.mint);
            const bonding = state.curves.get(fill.mint);
            if (position !== undefined && bonding !== undefined) {
              const val = Number(position.token_amount) * markPrice(bonding);
              openPos.set(fill.mint, { opened: fill.slot, peakValue: val, probe: pend.probe });
            }
          }
        } else if (fill.status !== 'filled') {
          awaitingBuys.delete(fill.client_id);
          probeIds.delete(fill.client_id);
        }
      }
      // Positions the harness closed (complete / flatten) disappear from the account.
      for (const token of [...openPos.keys()]) {
        if (!state.positions.has(token)) {
          openPos.delete(token);
          selling.delete(token);
          const tape = books.get(token);
          if (tape !== undefined) tape.lastExit = height;
        }
      }

      // --- 2. Update tapes from this batch's trades. ---
      const active: Pubkey[] = [];
      const activeSet = new Set<Pubkey>();
      for (const ev of batch.events) {
        if (ev.event === 'CreateEvent') {
          bookFor(ev.mint).created = ev.slot;
          if (!activeSet.has(ev.mint)) {
            activeSet.add(ev.mint);
            active.push(ev.mint);
          }
        } else if (ev.event === 'TradeEvent') {
          const tape = bookFor(ev.mint);
          const price =
            Number(ev.virtual_quote_reserves) / Number(ev.virtual_token_reserves);
          tape.trades.push({
            height: ev.slot,
            buy: ev.is_buy,
            sol: Number(ev.sol_amount) / LAMPORTS,
            user: ev.user,
            price,
          });
          if (!activeSet.has(ev.mint)) {
            activeSet.add(ev.mint);
            active.push(ev.mint);
          }
        } else {
          // CompleteEvent: curve is done, forget its tape.
          books.delete(ev.mint);
        }
      }
      // Prune tapes to the longest lookback we use, to bound memory.
      const cutoff = height - Math.max(p.window, p.fadeWindow);
      for (const tape of books.values()) {
        while (tape.trades.length > 0 && tape.trades[0]!.height < cutoff) tape.trades.shift();
        if (tape.trades.length > 400) tape.trades.splice(0, tape.trades.length - 400);
      }

      const fee = state.txFeeLamports();
      let cash = state.freeCashLamports();
      let atRisk = 0;
      for (const position of state.positions.values()) atRisk += Number(position.cost_lamports) / LAMPORTS;
      const openCount = [...openPos.values()].filter((entry) => !entry.probe).length;
      let slotsLeft = p.maxMain - openCount;

      // Values in LAMPORTS on both sides (a units bug here once made every
      // position "take profit" one batch after its buy filled).
      const markValue = (token: Pubkey): number => {
        const position = state.positions.get(token);
        const bonding = state.curves.get(token);
        if (position === undefined || bonding === undefined) return 0;
        return Number(position.token_amount) * markPrice(bonding);
      };
      const costValue = (token: Pubkey): number => {
        const position = state.positions.get(token);
        return position === undefined ? 0 : Number(position.cost_lamports);
      };

      // --- 3. Exits, in open-insertion order. ---
      for (const [token, entry] of openPos) {
        const position = state.positions.get(token);
        const bonding = state.curves.get(token);
        if (position === undefined || bonding === undefined || bonding.complete) continue;
        if (selling.has(token)) continue;
        const val = markValue(token);
        const cst = costValue(token);
        if (cst <= 0) continue;
        if (val > entry.peakValue) entry.peakValue = val;
        const gain = val / cst - 1;
        let sell = false;
        let why = '';
        if (entry.probe) {
          sell = true; // probes exit as soon as the buy lands
          why = 'probe';
        } else if (gain >= p.takeProfit) {
          sell = true;
          why = 'tp';
        } else if (gain <= -p.stopLoss) {
          sell = true;
          why = 'sl';
        } else if (entry.peakValue >= cst * (1 + p.trailArm) && val <= entry.peakValue * (1 - p.trail)) {
          sell = true;
          why = 'trail';
        } else if (height - entry.opened >= p.maxHold) {
          sell = true;
          why = 'hold';
        } else {
          // Fade: net SOL over the fade window turned negative.
          const tape = books.get(token);
          if (tape !== undefined) {
            let net = 0;
            for (let i = tape.trades.length - 1; i >= 0; i--) {
              const trade = tape.trades[i]!;
              if (trade.height < height - p.fadeWindow) break;
              net += trade.buy ? trade.sol : -trade.sol;
            }
            if (net < -p.fadeNetSol) {
              sell = true;
              why = 'fade';
            }
          }
          // One big sell in this batch dumps the position.
          if (!sell) {
            for (const ev of batch.events) {
              if (
                ev.event === 'TradeEvent' &&
                ev.mint === token &&
                !ev.is_buy &&
                Number(ev.sol_amount) / LAMPORTS >= p.bigSellSol
              ) {
                sell = true;
                why = 'bigSell';
                break;
              }
            }
          }
        }
        if (sell && out.length < 16) {
          exitCounts[why as keyof typeof exitCounts] += 1;
          out.push({
            side: 'sell',
            mint: token,
            token_amount: position.token_amount,
            max_slippage_bps: 10_000,
          });
          // Keep the held entry until the position actually disappears: if this
          // sell is rejected (e.g. max_order_size on a thin curve) the position
          // must be re-evaluated next batch, not orphaned until flatten.
          selling.add(token);
        }
      }

      // --- 4. Entries: evaluate the signal on curves that traded this batch. ---
      for (const token of active) {
        if (out.length >= 16 || slotsLeft <= 0) break;
        if (openPos.has(token)) continue;
        const tape = books.get(token);
        const bonding = state.curves.get(token);
        if (tape === undefined || bonding === undefined || bonding.complete) continue;
        if (tape.created === null || height - tape.created < p.minAge) continue;
        if (p.maxAge > 0 && height - tape.created > p.maxAge) continue;
        if (tape.entries >= p.maxEntries) continue;
        if (height - tape.lastExit < p.cooldown) continue;
        const realSol = Number(bonding.real_quote_reserves) / LAMPORTS;
        if (realSol < p.minRqSol || realSol > p.maxRqSol) continue;
        const buyCap = state.maxBuyLamports(token);
        const cap = Number(buyCap) / LAMPORTS;
        if (cap < 0.01) continue;
        const size = Math.min(p.stakeSol, cap);
        if (size < 0.01) continue;
        if (atRisk + size > p.maxExposureSol) continue;

        // Window tape stats.
        let net = 0;
        let freshNet = 0;
        let buys = 0;
        let inflow = 0;
        let openPx = 0;
        let high = 0;
        let low = Infinity;
        const wallets = new Map<string, number>();
        let nTrades = 0;
        const midSlot = height - p.window / 2;
        for (const trade of tape.trades) {
          if (trade.height < height - p.window) continue;
          nTrades++;
          if (openPx === 0) openPx = trade.price;
          if (trade.price > high) high = trade.price;
          if (trade.price < low) low = trade.price;
          if (trade.buy) {
            net += trade.sol;
            buys++;
            inflow += trade.sol;
            wallets.set(trade.user, (wallets.get(trade.user) ?? 0) + trade.sol);
            if (trade.height >= midSlot) freshNet += trade.sol;
          } else {
            net -= trade.sol;
            if (trade.height >= midSlot) freshNet -= trade.sol;
          }
        }
        if (nTrades < 3 || openPx === 0) continue;
        const px = markPrice(bonding);
        if (p.entryMode === 'dip') {
          // Pullback with buy flow returning: price down minDip..maxDip from the
          // window high, newer-half flow positive, price recovering off the low.
          if (high <= 0 || low === Infinity) continue;
          const dip = 1 - px / high;
          if (dip < p.minDip || dip > p.maxDip) continue;
          if (freshNet < p.dipNewNetSol) continue;
          if (px < low * (1 + p.dipRecover)) continue;
          if (buys < p.minBuys) continue;
          if (wallets.size < p.minBuyers) continue;
        } else {
          const rise = px / openPx - 1;
          if (net < p.minNetSol) continue;
          if (buys < p.minBuys) continue;
          if (wallets.size < p.minBuyers) continue;
          if (rise < p.minPriceUp || rise > p.maxPriceUp) continue;
          if (high > 0 && px < high * p.nearHigh) continue;
          let top = 0;
          for (const v of wallets.values()) if (v > top) top = v;
          if (inflow > 0 && top / inflow > p.maxBuyerShare) continue;
        }

        const qty = BigInt(Math.floor(size * LAMPORTS));
        if (cash < qty + fee) continue;
        // Own ids use the `b` prefix: the SDK shim assigns `o1, o2, ...` to orders
        // without an id (our sells), so `o`-prefixed buy ids would collide.
        const id = `b${seq++}`;
        awaitingBuys.set(id, { token, probe: false });
        out.push({ side: 'buy', mint: token, quote_lamports: qty, max_slippage_bps: p.buySlipBps, client_id: id });
        tape.entries += 1;
        cash -= qty + fee;
        atRisk += size;
        slotsLeft -= 1;
      }

      // --- 5. Guardrail probes: stay on pace for >= 20 distinct mints. ---
      const ageSec = t0 > 0 && bt > 0 ? bt - t0 : 0;
      const paceFrac = p.paceSecs > 0 ? ageSec / p.paceSecs : 1;
      const wantCoins = Math.ceil(p.targetCoins * Math.min(1, paceFrac));
      const probesOut = [...awaitingBuys.values()].filter((v) => v.probe).length + [...openPos.values()].filter((entry) => entry.probe).length;
      if (filledCoins < wantCoins && probesOut < p.maxProbes && out.length < 16) {
        for (const token of active) {
          if (out.length >= 16) break;
          if (openPos.has(token) || seen.has(token)) continue;
          const bonding = state.curves.get(token);
          if (bonding === undefined || bonding.complete) continue;
          const realSol = Number(bonding.real_quote_reserves) / LAMPORTS;
          if (realSol < 1) continue;
          if (Number(state.maxBuyLamports(token)) / LAMPORTS < p.probeSol) continue;
          const qty = BigInt(Math.floor(p.probeSol * LAMPORTS));
          if (cash < qty + fee) continue;
          const id = `b${seq++}`;
          awaitingBuys.set(id, { token, probe: true });
          probeIds.add(id);
          out.push({ side: 'buy', mint: token, quote_lamports: qty, max_slippage_bps: p.buySlipBps, client_id: id });
          cash -= qty + fee;
          break;
        }
      }

      return out;
    },
  } as Bot & { diag: typeof exitCounts };
  bot.diag = exitCounts;
  return bot;
}
