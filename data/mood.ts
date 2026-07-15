// Terrarium v2.1 — MOOD labels (pure).
//
// Stress (0..100) and momentum (0..100, 50=neutral) are derived in convex/mood.ts. These pure
// helpers turn the two scalars into words — one set shared by the dialogue prompt injector and
// the UI, so the panel and the character's own self-description never drift apart.

export type StressBand = 'calm' | 'strained' | 'stressed';
export type MomentumBand = 'stalled' | 'steady' | 'surging';

export function stressBand(stress: number): StressBand {
  if (stress >= 62) return 'stressed';
  if (stress >= 32) return 'strained';
  return 'calm';
}

export function momentumBand(momentum: number): MomentumBand {
  if (momentum >= 66) return 'surging';
  if (momentum >= 36) return 'steady';
  return 'stalled';
}

const STRESS_EMOJI: Record<StressBand, string> = { calm: '😌', strained: '😬', stressed: '😣' };
const MOMENTUM_EMOJI: Record<MomentumBand, string> = { stalled: '🪨', steady: '➡️', surging: '🚀' };

export function stressEmoji(stress: number): string {
  return STRESS_EMOJI[stressBand(stress)];
}
export function momentumEmoji(momentum: number): string {
  return MOMENTUM_EMOJI[momentumBand(momentum)];
}

// A first-person line for the character's prompt, only when the weather is notable — calm+steady
// returns nothing so we don't nag the model with "you feel normal". `reason` is an optional short
// clause ("a deadline's slipping") the deriver passes for color.
export function moodPromptLine(stress: number, momentum: number, reason?: string): string | null {
  const s = stressBand(stress);
  const m = momentumBand(momentum);
  if (s === 'calm' && m === 'steady') return null;
  const parts: string[] = [];
  if (s === 'stressed')
    parts.push(`You're under real strain right now${reason ? ` — ${reason}` : ''}`);
  else if (s === 'strained') parts.push(`You're a bit stretched${reason ? ` (${reason})` : ''}`);
  if (m === 'surging')
    parts.push(`things are clicking and you feel ahead of where you wanted to be`);
  else if (m === 'stalled')
    parts.push(`you feel stuck, like you're not moving toward what matters`);
  if (!parts.length) return null;
  return `How you're carrying yourself: ${parts.join('; ')}. Let it color your tone honestly — don't perform it.`;
}
