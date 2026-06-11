// Terrarium v1.8 — BELIEFS.
//
// Each character starts with a handful of convictions seeded from who they are. Beliefs are
// load-bearing: they color the work a character makes, how they argue in conversation, and how
// they react to other people's work. And they CHANGE — convictions drift in the overnight
// consolidation, and a controversial piece or a heated disagreement can move one on the spot.
//
// The seeds are deliberately in tension across the cast (founders vs. organizers on regulation,
// artists vs. founders on automation, the journalist skeptical of everyone) so the town has
// real fault lines to argue along.
//
// Wired in: convex/beliefs.ts (storage + seeding + evolution), convex/aiTown/agentComms.ts
// (composeArtifact reflects convictions), convex/agent/conversation.ts (dialogue argues from
// them), convex/aiTown/agentOperations.ts (maybeReactToWork shifts them).

export type SeedBelief = {
  // A short handle for what the belief is about (used to match reactions to the right belief).
  topic: string;
  // The position itself, first person, in the character's voice.
  statement: string;
  // 0..100 — how strongly it's held.
  conviction: number;
};

export const SEED_BELIEFS: Record<string, SeedBelief[]> = {
  Priya: [
    { topic: 'AI safety', statement: 'The capability curve is real and we are not ready — slowing down is the responsible choice, not cowardice.', conviction: 78 },
    { topic: 'open release', statement: 'Truly powerful models should not be handed to everyone before we understand what they can do.', conviction: 70 },
    { topic: 'automation', statement: 'Most knowledge work will be augmented, not erased — but the transition will be brutal for real people.', conviction: 60 },
  ],
  Mara: [
    { topic: 'regulation', statement: 'Heavy AI regulation just entrenches the incumbents and crushes the small builders who actually move things.', conviction: 80 },
    { topic: 'automation', statement: 'If a tool can do the work, the work should be done by the tool. That is what progress has always meant.', conviction: 75 },
    { topic: 'AI safety', statement: 'The doomers are slowing down the most important technology of our lifetimes out of fear.', conviction: 62 },
  ],
  Russ: [
    { topic: 'AI in medicine', statement: 'I will not trust a model with a life I am accountable for. Tools assist; they do not decide.', conviction: 82 },
    { topic: 'automation', statement: 'Some work is irreducibly human. Mine is one of them.', conviction: 70 },
    { topic: 'hype', statement: 'The discourse is noise. The patient in front of me is the only thing that is real.', conviction: 74 },
  ],
  Naomi: [
    { topic: 'evidence', statement: 'Claims without measurement are just vibes. Show me the numbers or stop talking.', conviction: 85 },
    { topic: 'AI capability', statement: 'Most "breakthroughs" do not survive contact with real data.', conviction: 64 },
    { topic: 'automation', statement: 'Augmentation beats replacement — when you actually measure the outcomes.', conviction: 60 },
  ],
  Gloria: [
    { topic: 'regulation', statement: 'Technology this powerful has to be accountable to the people it affects, not just the people who profit.', conviction: 80 },
    { topic: 'labor', statement: 'If automation creates wealth, the city has to make sure the workers who lost out share in it.', conviction: 76 },
    { topic: 'process', statement: '"Move fast and break things" is how you break a city.', conviction: 70 },
  ],
  Theo: [
    { topic: 'AI art', statement: 'A machine can imitate the surface of art but never the reason for it.', conviction: 85 },
    { topic: 'automation', statement: 'When everything can be generated, the things made by human hands become priceless.', conviction: 72 },
    { topic: 'meaning', statement: 'Work that costs the maker nothing is worth nothing.', conviction: 66 },
  ],
  Desmond: [
    { topic: 'power', statement: 'Every powerful institution lies until somebody makes them stop.', conviction: 80 },
    { topic: 'AI', statement: 'The labs want you dazzled so you forget to ask who is accountable when it goes wrong.', conviction: 72 },
    { topic: 'automation', statement: 'They will automate the reporters long before they automate the executives.', conviction: 65 },
  ],
  Yuki: [
    { topic: 'labor', statement: 'Whatever the technology, the people doing the work deserve a seat at the table.', conviction: 85 },
    { topic: 'automation', statement: 'Progress that leaves people behind is not progress — it is abandonment.', conviction: 80 },
    { topic: 'community', statement: 'Nobody is saved alone.', conviction: 76 },
  ],
};

export function seedBeliefsFor(character: string): SeedBelief[] {
  return SEED_BELIEFS[character] ?? [];
}
