// Terrarium v1.3 — WORLD CLOCK (day/night model).
//
// Pure, dependency-free time math shared by the convex backend and the React frontend.
// The clock is ANCHORED: at real timestamp `epochRealMs` the world stood at `epochWorldMs`
// world-milliseconds and advances at `speed` world-ms per real-ms. To change speed we
// re-anchor (see convex/clock.ts setSpeed) so the displayed time never jumps.
//
// Used by:
//   - convex/clock.ts            -> the anchored worldClock record + getClock/setSpeed.
//   - convex/aiTown/agentOperations.ts -> phase biases where agents go (work by day, home at night).
//   - convex/agent/conversation.ts + agentComms.ts -> injects the time into prompts.
//   - src/components/WorldClock.tsx    -> the on-screen clock + speed toggle + night tint.

export type WorldClock = {
  // Anchor: at real time `epochRealMs` the world was at `epochWorldMs` world-ms.
  epochRealMs: number;
  epochWorldMs: number;
  // World-ms elapsed per real-ms. 1 = real-time model, 2 = twice as fast, etc.
  speed: number;
};

// One world-DAY takes this many REAL milliseconds at speed 1.
// 24 real minutes per day => 1 real minute ≈ 1 world hour. Short enough to watch a full
// cycle in a sitting; the speed button compresses it further.
export const WORLD_DAY_MS = 24 * 60 * 1000;

export const SPEED_OPTIONS = [1, 2, 4, 8] as const;

export type Phase = 'night' | 'morning' | 'work' | 'evening';

export type WorldTime = {
  day: number; // 1-based day counter
  hour: number; // 0..23
  minute: number; // 0..59
  frac: number; // 0..1 progress through the current day
  phase: Phase;
};

export function worldMsAt(clock: WorldClock, nowReal: number): number {
  return Math.max(0, clock.epochWorldMs + (nowReal - clock.epochRealMs) * clock.speed);
}

export function phaseForHour(hour: number): Phase {
  if (hour < 6 || hour >= 22) return 'night';
  if (hour < 9) return 'morning';
  if (hour < 18) return 'work';
  return 'evening';
}

export function worldTime(clock: WorldClock, nowReal: number): WorldTime {
  const ms = worldMsAt(clock, nowReal);
  const day = Math.floor(ms / WORLD_DAY_MS) + 1;
  const frac = (ms % WORLD_DAY_MS) / WORLD_DAY_MS;
  const totalMin = Math.floor(frac * 24 * 60);
  const hour = Math.floor(totalMin / 60);
  const minute = totalMin % 60;
  return { day, hour, minute, frac, phase: phaseForHour(hour) };
}

const PHASE_EMOJI: Record<Phase, string> = {
  night: '🌙',
  morning: '🌅',
  work: '☀️',
  evening: '🌆',
};

export function phaseEmoji(phase: Phase): string {
  return PHASE_EMOJI[phase];
}

// "Day 2 · 14:30" — a compact human label.
export function clockLabel(t: WorldTime): string {
  const hh = String(t.hour).padStart(2, '0');
  const mm = String(t.minute).padStart(2, '0');
  return `Day ${t.day} · ${hh}:${mm}`;
}

// A one-line, in-world description of the time for an agent's prompt, e.g.
// "It's the middle of the night (02:10) — most people are home asleep."
export function timeOfDayPrompt(t: WorldTime): string {
  const hh = String(t.hour).padStart(2, '0');
  const mm = String(t.minute).padStart(2, '0');
  const clock = `${hh}:${mm}`;
  switch (t.phase) {
    case 'night':
      return `It's the middle of the night (${clock}). Most people are home asleep; the town is quiet.`;
    case 'morning':
      return `It's morning (${clock}). People are waking up, grabbing coffee, heading out to start the day.`;
    case 'work':
      return `It's the middle of the working day (${clock}). People are at work — at their jobs, building, meeting, getting things done.`;
    case 'evening':
      return `It's evening (${clock}). The workday is winding down; people are out, unwinding, socializing.`;
  }
}

// How dark the night overlay should be, 0 (full day) .. ~0.55 (deep night). Smoothly
// ramps at dawn/dusk so the frontend tint breathes instead of snapping.
export function nightOverlayAlpha(t: WorldTime): number {
  const h = t.hour + t.minute / 60;
  // Brightness curve: 0 at deep night, 1 at midday.
  let brightness: number;
  if (h < 5 || h >= 23) brightness = 0;
  else if (h < 8) brightness = (h - 5) / 3; // dawn 05–08
  else if (h < 18) brightness = 1; // full day 08–18
  else if (h < 23) brightness = 1 - (h - 18) / 5; // dusk 18–23
  else brightness = 0;
  return (1 - brightness) * 0.55;
}
