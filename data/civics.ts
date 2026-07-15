// Terrarium v2.6 — CIVIC OUTCOMES (collective stakes that RESOLVE).
//
// Factions gave the town sides; gossip gave it a nervous system; this gives it CONSEQUENCE. A civic
// issue is a town-wide proposition that gets DECIDED — producing winners and losers. It's where the
// group tier finally pays off: factions are the organized blocs, beliefs are where people start,
// gossip/relationships are how they get persuaded, and standing is whose voice carries. Then it
// resolves, and the result lands on everyone's status, mood, convictions, and faction cohesion.
//
// Design intent (alexa, throughout): emergent + non-coercive. An issue arises from a charged fault
// line that already has a faction behind it; nobody is forced into a side — your stance comes from
// YOUR beliefs, nudged only by people you actually listen to. The resolution is a weighted tally of
// where people genuinely landed, not a scripted result.
//
// Wired in: convex/schema.ts (civicIssues + civicStances), convex/civics.ts (open/lobby/resolve +
// reads), agentComms (composeCivicTake), agentOperations (maybeProposeIssue / maybeCampaign / resolve
// in the nightly pass), conversation.ts (the live issue colors talk), PlayerDetails + a town banner.

import { ChargedTopic, Pole, poleLabel } from './factions';

export type Stance = 'support' | 'oppose' | 'undecided';

// One proposition per charged fault line. `favorsPole` is the side it advances (so that pole's
// believers support it); `material` is a one-time real consequence on resolution beyond status/mood.
export type Proposition = {
  topic: ChargedTopic;
  favorsPole: Pole;
  title: string;
  text: string;
  // A short label for the concrete effect if it PASSES (applied once on resolve; see convex/civics).
  materialNote: string;
};

export const PROPOSITIONS: Record<ChargedTopic, Proposition> = {
  regulation: {
    topic: 'regulation',
    favorsPole: 1, // accountability & guardrails
    title: 'AI Accountability Ordinance',
    text: 'A municipal ordinance requiring disclosure and independent oversight for high-impact AI systems used in the city.',
    materialNote: 'the builders feel the constraint',
  },
  automation: {
    topic: 'automation',
    favorsPole: -1, // protect human work
    title: 'Worker Transition Fund',
    text: 'A publicly funded retraining and income-bridge program for workers displaced by automation.',
    materialNote: 'a cushion for those living closest to the edge',
  },
  'AI safety': {
    topic: 'AI safety',
    favorsPole: 1, // slow down for safety
    title: 'Frontier Deployment Review',
    text: 'A resolution urging a local pause and safety review before frontier AI systems are deployed at scale in the city.',
    materialNote: 'a brake on the fastest movers',
  },
};

export function propositionFor(topic: string): Proposition | null {
  return (PROPOSITIONS as Record<string, Proposition>)[topic] ?? null;
}

// Can a proposition be put to the town again, given how it last resolved? (v2.8 — stops a faction
// lead from re-proposing the same thing on a loop the moment it resolves.)
//   - never decided        -> open
//   - PASSED               -> enacted; locked (there's no repeal/amend mechanic yet, so it stays)
//   - FAILED               -> the town "let it go, for now"; revisitable after a cooldown
export function topicReproposable(
  latest: { passed: boolean; resolvedDay: number } | null,
  currentDay: number,
): boolean {
  if (!latest) return true;
  if (latest.passed) return false;
  return currentDay - latest.resolvedDay >= CIVIC_REVISIT_DAYS;
}

// ── timing + gates ───────────────────────────────────────────────────────────────────────────────

export const CIVIC_CAMPAIGN_DAYS = 3; // an issue campaigns this many world-days, then resolves
export const CIVIC_REVISIT_DAYS = 5; // a FAILED proposition can't be re-litigated for this many days
export const PROPOSE_ISSUE_CHANCE = 0.06;
export const PROPOSE_ISSUE_COOLDOWN_MS = 1000 * 60 * 20; // per-agent, so issues don't spam
export const LOBBY_CHANCE = 0.16;
export const LOBBY_COOLDOWN_MS = 1000 * 60 * 6;

// ── stance + persuasion dynamics ────────────────────────────────────────────────────────────────

// Where a character starts on a proposition, from their OWN belief side on the topic. Faction
// membership amplifies (an organized bloc shows up committed); no side → undecided, low weight.
// Returns stance + a 0..100 weight (how firmly/loudly they hold it — feeds the tally + persuadability).
export function initialStance(
  memberPole: Pole | null,
  conviction: number,
  prop: Proposition,
  factionAlignment: 0 | 1 | -1, // +1 in the proposing faction, -1 in its rival, 0 neither
): { stance: Stance; weight: number } {
  if (memberPole == null && factionAlignment === 0) {
    return { stance: 'undecided', weight: 18 };
  }
  const favors = memberPole != null && Math.sign(memberPole) === Math.sign(prop.favorsPole);
  let weight = memberPole != null ? Math.max(20, conviction) : 30;
  weight += factionAlignment !== 0 ? 18 : 0;
  weight = Math.max(0, Math.min(100, weight));
  if (factionAlignment === 1) return { stance: 'support', weight };
  if (factionAlignment === -1) return { stance: 'oppose', weight };
  return { stance: favors ? 'support' : 'oppose', weight };
}

// A persuasion attempt: a lobbyist with a stance nudges a target's standing on the issue, weighted by
// CREDIBILITY (target's trust in lobbyist) and the lobbyist's own conviction. Undecideds and the
// weakly-held are moved most; the firmly-committed barely budge. Returns the target's new stance +
// weight. Non-coercive: it only shifts in proportion to a trust the target already holds.
export const PERSUADE_MAX = 16;
export function persuade(
  target: { stance: Stance; weight: number },
  lobbyStance: Stance,
  lobbyWeight: number,
  credibility: number, // 0..1
): { stance: Stance; weight: number } {
  if (lobbyStance === 'undecided') return target;
  const push = (lobbyWeight / 100) * credibility * PERSUADE_MAX;
  if (push < 1) return target;

  // Same side → reinforce. Opposed → erode, and flip if it crosses zero.
  if (target.stance === lobbyStance) {
    return { stance: lobbyStance, weight: Math.min(100, target.weight + push) };
  }
  if (target.stance === 'undecided') {
    return { stance: lobbyStance, weight: Math.min(100, 20 + push) };
  }
  const w = target.weight - push;
  if (w <= 0) return { stance: lobbyStance, weight: Math.min(100, -w + 8) }; // flipped
  return { stance: target.stance, weight: w };
}

// ── tally + outcome ──────────────────────────────────────────────────────────────────────────────

// Weighted tally of final stances → outcome. Weight models turnout × intensity (a passionate bloc
// carries more than lukewarm assent). A tie fails (the status quo holds).
export function tally(stances: { stance: Stance; weight: number }[]): {
  forWeight: number;
  againstWeight: number;
  supporters: number;
  opposers: number;
  passed: boolean;
} {
  let forWeight = 0;
  let againstWeight = 0;
  let supporters = 0;
  let opposers = 0;
  for (const s of stances) {
    if (s.stance === 'support') {
      forWeight += s.weight;
      supporters++;
    } else if (s.stance === 'oppose') {
      againstWeight += s.weight;
      opposers++;
    }
  }
  return { forWeight, againstWeight, supporters, opposers, passed: forWeight > againstWeight };
}

// Did a character end up on the winning side? (For consequences.)
export function isWinner(stance: Stance, passed: boolean): boolean | null {
  if (stance === 'support') return passed;
  if (stance === 'oppose') return !passed;
  return null; // undecided — no strong stake
}

export function outcomeHeadline(prop: Proposition, passed: boolean): string {
  return passed
    ? `The ${prop.title} PASSED — ${prop.materialNote}.`
    : `The ${prop.title} FAILED — the town let it go, for now.`;
}

// A short human description of where someone stands, for prompts/UI.
export function stanceLabel(stance: Stance, prop: Proposition): string {
  if (stance === 'support') return `for the ${prop.title}`;
  if (stance === 'oppose') return `against the ${prop.title}`;
  return `undecided on the ${prop.title}`;
}

// Re-exported helper so the convex layer can label the favored side in prose.
export function favoredSideLabel(prop: Proposition): string {
  return poleLabel(prop.topic, prop.favorsPole);
}
