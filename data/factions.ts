// Terrarium v2.3 — FACTIONS (the group tier).
//
// The sim was rich at the INDIVIDUAL level (drives/beliefs/goals/mood) and the DYAD level
// (relationships/conversations/plans) but ~empty at the GROUP level — and "society" lives in the
// meso tier. Factions are the structural primitive that turns the town's belief fault-lines into
// SIDES: persistent groups that take public stances, draw people in, and push against a rival.
//
// The key design choice (alexa): affiliation is a LIVING FIELD, not a roster. Every character has
// a COMMITMENT score (0..100) to *each* faction — an edge that moves over time. That one idea
// gives us everything:
//   • different amounts of committed        → it's the score.
//   • multiple memberships                  → multiple nonzero edges (primary = the highest).
//   • interest in other factions            → secondary edges ("drawn toward …").
//   • commitment changes as they respond to what the faction DOES → nightly recompute from cheap
//     signals: approve/disapprove of the faction's public moves, belief-drift realignment, and
//     social pull from who their close ties are. Crossing thresholds IS joining/leaving.
//
// LLM calls are reserved for the rare flavored moments (founding a faction; a faction taking a
// public stance). Everything else here is pure numeric dynamics — defined below so the Convex
// layer stays thin and this stays testable.
//
// Wired in: convex/schema.ts (factions + factionTies tables), convex/factions.ts (storage +
// dynamics), convex/aiTown/agentComms.ts (composeFactionFounding / composeFactionMove),
// convex/aiTown/agentOperations.ts (maybeFormFaction / maybeFactionMove / nightly affiliation
// recompute), convex/agent/conversation.ts (factionPrompt), PlayerDetails (the panel).

// ── Fault lines ───────────────────────────────────────────────────────────────────────────────

// The charged topics with two real sides in the cast (read off data/beliefs.ts SEED_BELIEFS).
export const CHARGED_TOPICS = ['regulation', 'automation', 'AI safety'] as const;
export type ChargedTopic = (typeof CHARGED_TOPICS)[number];

export type Pole = 1 | -1;

// A character's SIDE on each charged topic — +1 and -1 are just the two banks of the fault line;
// POLE_LABEL says which is which. This is a stable PRIOR for sign (who tends to stand where),
// derived from the seed convictions; live conviction STRENGTH comes from the current beliefs, so a
// character softening their conviction still erodes out of a hardline faction on its own.
export const TOPIC_POLE: Record<string, Partial<Record<ChargedTopic, Pole>>> = {
  Mara: { regulation: -1, automation: 1, 'AI safety': -1 },
  Priya: { 'AI safety': 1, automation: -1 },
  Naomi: { automation: 1 },
  Gloria: { regulation: 1, automation: -1 },
  Yuki: { regulation: 1, automation: -1 },
  Desmond: { regulation: 1 },
  Theo: { automation: -1 },
  Russ: { automation: -1 },
};

export const POLE_LABEL: Record<ChargedTopic, Record<'1' | '-1', string>> = {
  regulation: { '1': 'accountability & guardrails', '-1': 'builder freedom' },
  automation: { '1': 'accelerate the work', '-1': 'protect human work' },
  'AI safety': { '1': 'slow down for safety', '-1': 'speed over fear' },
};

export function poleLabel(topic: string, pole: number): string {
  const t = POLE_LABEL[topic as ChargedTopic];
  if (!t) return '';
  return t[pole >= 0 ? '1' : '-1'];
}

// The stable side prior for a character on a topic (null if they have no strong seeded side).
export function priorPole(name: string, topic: string): Pole | null {
  return TOPIC_POLE[name]?.[topic as ChargedTopic] ?? null;
}

// ── Thresholds & dynamics constants ─────────────────────────────────────────────────────────────

// A faction only crystallizes around a conviction this strong (founder's belief).
export const FOUND_CONVICTION = 70;
// A founding faction's starting intensity (how hardline it is; moves with what it does).
export const FOUND_INTENSITY = 60;

// Commitment band → what the tie MEANS.
export const MEMBER_AT = 50; // at/above: a real member
export const CURIOUS_AT = 18; // at/above (but below MEMBER_AT): a sympathizer, "drawn toward"
export const DROP_BELOW = 12; // below: the tie has withered; remove it

// Starting commitments when a faction forms / someone is pulled in.
export const FOUNDER_COMMIT = 90;
export const RECRUIT_COMMIT = 58; // an aligned ally the founder invites at birth
export const CURIOUS_SEED = 24; // a latent pull seeded by alignment, no action yet

// How fast nightly belief-realignment pulls commitment toward its equilibrium.
export const REALIGN_RATE = 0.34;
// Social pull: how much your close ties among co-members tug your commitment each night.
export const SOCIAL_PULL_MAX = 6;
// A member tolerates a faction this much more extreme than their own conviction before the
// over-reach starts to push them away.
export const DISCOMFORT_GAP = 22;

// Per-move reaction magnitudes (approve / disapprove of a public stance the faction took).
export const APPROVE_MAX = 14;
export const DISAPPROVE_MAX = 16;
export const RIVAL_RALLY = 7; // a rival's aggressive move HARDENS your own side (rally effect)

const clamp = (n: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));

// ── Alignment & equilibrium ─────────────────────────────────────────────────────────────────────

// How well a character (their pole + live conviction on the faction's topic) sits with a faction's
// current (pole, intensity). Returns -1..1: +1 fully aligned & comfortable, negative = opposed or
// the faction has gotten too extreme for them. This is the equilibrium that nightly recompute pulls
// commitment toward, and the basis for move reactions.
export function alignment(
  memberPole: Pole | null,
  memberConviction: number,
  faction: { pole: number; intensity: number },
): number {
  if (memberPole == null) return 0; // no side on this topic → indifferent
  const sameSide = Math.sign(memberPole) === Math.sign(faction.pole);
  if (!sameSide) {
    // Opposed: how strongly, scaled by how loud the faction is.
    return -clamp(memberConviction, 0, 100) / 100 * (0.5 + faction.intensity / 200);
  }
  // Same side: aligned in proportion to conviction, MINUS discomfort if the faction is more
  // extreme than they are (the over-reach that radicalization sheds moderates on).
  const base = clamp(memberConviction, 0, 100) / 100;
  const overreach = Math.max(0, faction.intensity - (memberConviction + DISCOMFORT_GAP)) / 100;
  return clamp(base - overreach * 1.4, -1, 1) as number;
}

// Nightly: ease commitment toward the equilibrium implied by current alignment (belief-drift shows
// up here — as convictions move, ties strengthen or wither on their own), plus a social tug.
export function nightlyCommitment(
  commitment: number,
  align: number,
  socialPull01: number, // -1..1 : net warmth toward co-members
): number {
  const target = clamp((align + 1) / 2 * 100); // map -1..1 → 0..100
  let next = commitment + (target - commitment) * REALIGN_RATE;
  next += socialPull01 * SOCIAL_PULL_MAX;
  return clamp(next);
}

// A character's commitment delta in reaction to a public MOVE.
//   ownFaction  — the move is by a faction they're tied to (approve/disapprove of "us").
//   rivalMove   — the move is by the rival of a faction they're tied to (may rally them).
export function reactionToMove(
  memberPole: Pole | null,
  memberConviction: number,
  move: { pole: number; intensity: number },
  kind: 'own' | 'rival',
): number {
  const a = alignment(memberPole, memberConviction, move);
  if (kind === 'own') {
    return a >= 0 ? a * APPROVE_MAX : a * DISAPPROVE_MAX; // a already signed
  }
  // Rival move: if it's loud and on the topic you care about, it hardens you (rally), regardless
  // of whether you'd "approve" — opposition is galvanizing. Small, only when you have a side.
  if (memberPole == null) return 0;
  return (move.intensity / 100) * RIVAL_RALLY * (clamp(memberConviction) / 100);
}

// Band label for a commitment score (for UI + role bookkeeping).
export function commitmentBand(commitment: number): 'core' | 'member' | 'curious' | 'fringe' {
  if (commitment >= 78) return 'core';
  if (commitment >= MEMBER_AT) return 'member';
  if (commitment >= CURIOUS_AT) return 'curious';
  return 'fringe';
}

// Two factions on the SAME charged topic are rivals — they crystallized from opposite banks of one
// fault line (an aligned newcomer JOINS the existing one; only an OPPOSED strong voice founds the
// rival), so same-topic ⇒ rivalry.
export function areRivals(a: { topic: string; pole: number }, b: { topic: string; pole: number }) {
  return a.topic === b.topic && Math.sign(a.pole) !== Math.sign(b.pole);
}
