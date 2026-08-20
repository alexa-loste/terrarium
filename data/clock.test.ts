import { describe, expect, test } from '@jest/globals';
import {
  WorldClock,
  WORLD_DAY_MS,
  effectiveClock,
  effectiveSpeed,
  reanchor,
  worldMsAt,
  worldTime,
} from './clock';

// THE INVARIANT: re-anchoring moves the ANCHOR, never the WORLD.
//
// Every writer in convex/clock.ts (freeze, unfreeze, setSpeed, reconcileNightSpeed) rewrites the
// anchor, and each one used to do its own arithmetic against `clock.speed`. The readers used the
// EFFECTIVE speed — 0 while frozen. The two only disagree while frozen, which is precisely when
// nobody is looking at the screen, so the disagreement banked up silently in both directions:
// unfreezing a running clock DELETED world-days, freezing a frozen one INVENTED them.
//
// alexa's town is the live case: it read day 447, then day 426, with all eight characters exactly
// 21 years younger. Nothing else in the sim can move time backwards.
//
// So the assertions below are all one question asked of the four transitions: where is the world
// immediately before this write, and where is it immediately after?

const MIN = 60 * 1000;

// Position as the READERS compute it. Deliberately expressed through effectiveClock/worldMsAt
// rather than by re-deriving the arithmetic here: an assertion that recomputes what it is checking
// can agree with a broken writer.
function positionAt(clock: WorldClock, frozen: boolean, now: number): number {
  return worldMsAt(effectiveClock(clock, frozen), now);
}

function dayOf(clock: WorldClock, frozen: boolean, now: number): number {
  return worldTime(effectiveClock(clock, frozen), now).day;
}

// A running clock anchored at t=0, sitting at the start of day 100.
const T0 = 1_000_000_000_000;
const RUNNING: WorldClock = { epochRealMs: T0, epochWorldMs: 99 * WORLD_DAY_MS, speed: 1 };

describe('effectiveSpeed', () => {
  test('a frozen clock advances at 0 whatever speed it will resume at', () => {
    expect(effectiveSpeed({ ...RUNNING, speed: 4 }, true)).toBe(0);
    expect(effectiveSpeed({ ...RUNNING, speed: 4 }, false)).toBe(4);
  });

  test('the stored speed survives a freeze, so resuming keeps it', () => {
    const frozen = reanchor({ ...RUNNING, speed: 4 }, false, T0 + 10 * MIN);
    expect(frozen.speed).toBe(4);
  });
});

describe('re-anchoring never moves the world', () => {
  // T1 — the ordinary freeze. This one was always right; it is here so a regression in the shared
  // helper cannot pass by only fixing the exotic cases.
  test('freezing a RUNNING clock preserves the position', () => {
    const at = T0 + 90 * MIN;
    const before = positionAt(RUNNING, false, at);
    const after = reanchor(RUNNING, false, at);
    expect(positionAt(after, true, at)).toBe(before);
  });

  // T2 — and then it must actually stop.
  test('a frozen clock does not advance while frozen', () => {
    const at = T0 + 90 * MIN;
    const frozen = reanchor(RUNNING, false, at);
    expect(positionAt(frozen, true, at + 8 * 60 * MIN)).toBe(positionAt(frozen, true, at));
  });

  // T3 — INVENTED DAYS. stopInactiveWorlds and testing:stop can both freeze; state can already be
  // frozen when one of them fires.
  test('freezing an ALREADY FROZEN clock invents nothing', () => {
    const frozen = reanchor(RUNNING, false, T0 + 90 * MIN);
    const later = T0 + 90 * MIN + 12 * 60 * MIN;
    const again = reanchor(frozen, true, later);
    expect(positionAt(again, true, later)).toBe(positionAt(frozen, true, later));
  });

  // T4 — the ordinary resume.
  test('unfreezing a FROZEN clock preserves the position, then runs again', () => {
    const frozen = reanchor(RUNNING, false, T0 + 90 * MIN);
    const resumeAt = T0 + 90 * MIN + 5 * 60 * MIN;
    const held = positionAt(frozen, true, resumeAt);
    const resumed = reanchor(frozen, true, resumeAt);
    expect(positionAt(resumed, false, resumeAt)).toBe(held);
    expect(positionAt(resumed, false, resumeAt + WORLD_DAY_MS)).toBe(held + WORLD_DAY_MS);
  });

  // T5 — DELETED DAYS. This is the one that bit the live town. `status` and `frozen` are separate
  // state, so unfreeze is reachable on a clock that was never frozen.
  test('unfreezing a clock that was still RUNNING does not roll time back', () => {
    const resumeAt = T0 + 8.4 * 60 * MIN;
    const before = positionAt(RUNNING, false, resumeAt);
    const resumed = reanchor(RUNNING, false, resumeAt);
    expect(positionAt(resumed, false, resumeAt)).toBe(before);
  });

  // T6 — the live regression, stated in the units alexa reads on screen.
  test('the 21 lost days: resuming an unfrozen clock keeps the day it was on', () => {
    // 21 world-days at speed 1 is 8.4 real hours of a clock nobody froze.
    const resumeAt = T0 + 21 * WORLD_DAY_MS;
    expect(dayOf(RUNNING, false, resumeAt)).toBe(121);
    const resumed = reanchor(RUNNING, false, resumeAt);
    expect(dayOf(resumed, false, resumeAt)).toBe(121);
  });

  // T7 — speed changes re-anchor too, and setSpeed does not check frozen for itself.
  test('changing speed on a FROZEN clock does not advance it', () => {
    const frozen = reanchor({ ...RUNNING, speed: 1 }, false, T0 + 90 * MIN);
    const later = T0 + 90 * MIN + 3 * 60 * MIN;
    const respeeded = { ...reanchor(frozen, true, later), speed: 4 };
    expect(positionAt(respeeded, true, later)).toBe(positionAt(frozen, true, later));
  });

  // T8 — a fast clock must keep the time it earned at the speed it earned it.
  test('re-anchoring at speed 4 preserves a fast clock exactly', () => {
    const fast: WorldClock = { ...RUNNING, speed: 4 };
    const at = T0 + 30 * MIN;
    const before = positionAt(fast, false, at);
    expect(before).toBe(99 * WORLD_DAY_MS + 4 * 30 * MIN);
    expect(positionAt(reanchor(fast, false, at), false, at)).toBe(before);
  });
});
