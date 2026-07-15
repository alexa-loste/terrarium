// Terrarium v2.4 — GOSSIP (third-party reputation).
//
// Factions gave the town sides; gossip gives it a NERVOUS SYSTEM. It's how A shapes B's view of an
// absent C — the thing that makes the relationship graph propagate transitively (you cool on someone
// you've never clashed with because a friend you trust soured on them; you warm to a stranger your
// confidant praises). It's the engine under alliance, status, and quiet betrayal.
//
// Design intent (alexa): the town should self-organize, NOT get coerced. So gossip here is:
//   • driven by each speaker's OWN genuine feelings (they only pass along a take they actually hold),
//   • weighted by CREDIBILITY — a trusted friend moves you, a near-stranger barely does,
//   • gentle (small nudges), and BIDIRECTIONAL — praise travels as readily as a complaint.
// No global force makes anyone mean; reputation just flows along the edges that already exist.
//
// Wired in: convex/schema.ts (gossipEvents), convex/gossip.ts (record + reads), agentComms
// (composeGossip), agentOperations (maybeGossip), conversation.ts (what you've heard colors how you
// treat them), PlayerDetails (🗣️ Word going around).

export const GOSSIP_COOLDOWN_MS = 1000 * 60 * 7; // at most ~once / 7 min real-time, per speaker
export const GOSSIP_CHANCE = 0.14;

// You only confide in someone you actually feel warm toward.
export const CONFIDANT_MIN_AFFINITY = 56;
// And you only pass along a take you genuinely hold — a real opinion, warm or cool, about the subject.
export const OPINION_THRESHOLD = 14;

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

// How strongly the speaker feels about a third party, signed: combine warmth + esteem. Positive =
// they'd talk them up, negative = they'd run them down. Magnitude is how much there is to say.
export function opinionScore(rel: { affinity: number; respect: number }): number {
  return rel.affinity - 50 + (rel.respect - 50) * 0.6;
}

// +1 warm / -1 cool / 0 = no strong take (don't bother gossiping).
export function valenceOf(rel: { affinity: number; respect: number }): -1 | 0 | 1 {
  const s = opinionScore(rel);
  if (s >= OPINION_THRESHOLD) return 1;
  if (s <= -OPINION_THRESHOLD) return -1;
  return 0;
}

// How much the LISTENER lets the speaker move them — their trust in the speaker, 0.15..1. Even a
// near-stranger's word lands a little; a trusted confidant's lands fully. This is the guardrail that
// keeps gossip from being mind-control: it rides existing trust, it doesn't manufacture opinion.
export function credibility(listenerTrustInSpeaker: number): number {
  return clamp((listenerTrustInSpeaker - 30) / 50, 0.15, 1);
}

// The nudge applied to the listener's view of the subject, given gossip valence + credibility.
// Returns warmth/respect deltas on relationships' -3..3 scale (gentle: max ~2 warmth).
export function gossipNudge(
  valence: -1 | 0 | 1,
  cred: number,
): { warmth: number; respect: number } {
  if (!valence) return { warmth: 0, respect: 0 };
  const warmth = Math.round(valence * 2 * cred);
  const respect = Math.round(valence * 1.4 * cred);
  return { warmth, respect };
}

// A short hint for the compose prompt — how the speaker is leaning about the subject.
export function feelingHint(rel: { affinity: number; respect: number }): string {
  const s = opinionScore(rel);
  if (s >= 28) return 'you genuinely admire them';
  if (s >= OPINION_THRESHOLD) return 'you like them / think well of them';
  if (s <= -28) return "you really don't rate them";
  if (s <= -OPINION_THRESHOLD) return 'they rub you the wrong way';
  return 'you have mixed feelings';
}
