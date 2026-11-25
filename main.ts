// Completion Rider — the entrypoint the grader executes (`node /bot/main.ts` on Node 22).
// The trading logic lives in strategy.ts; the SDK shim is the kit's own file,
// vendored byte for byte from sdk/ts/makefun-bot.ts.
//
// Determinism note: every decision comes only from the batch stream — slots,
// events, marks, fills, account — with no clock, no randomness, no environment
// and no network, so two runs of this entry log byte-identical actions.

import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';
import { runBot as startBot } from './vendor/makefun-bot.ts';

const strategy = createStrategy(DEFAULT_PARAMS);

await startBot(strategy);
