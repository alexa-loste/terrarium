import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';
import { agentTables } from './agent/schema';
import { aiTownTables } from './aiTown/schema';
import { conversationId, playerId } from './aiTown/ids';
import { engineTables } from './engine/schema';

export default defineSchema({
  music: defineTable({
    storageId: v.string(),
    type: v.union(v.literal('background'), v.literal('player')),
  }),

  messages: defineTable({
    conversationId,
    messageUuid: v.string(),
    author: playerId,
    text: v.string(),
    worldId: v.optional(v.id('worlds')),
  })
    .index('conversationId', ['worldId', 'conversationId'])
    .index('messageUuid', ['conversationId', 'messageUuid']),

  // The public "internet" feed: posts, "research", and world/news events. v1.2 Step 1.
  feedPosts: defineTable({
    worldId: v.id('worlds'),
    // authorPlayerId is set when an agent posts (v1.2 Step 3); null for human/news posts.
    authorPlayerId: v.union(playerId, v.null()),
    authorName: v.string(),
    kind: v.union(v.literal('post'), v.literal('research'), v.literal('news')),
    text: v.string(),
    createdAt: v.number(),
  }).index('worldId', ['worldId']),

  // Async direct messages between agents (v1.2 Step 4) — delivered regardless of distance.
  directMessages: defineTable({
    worldId: v.id('worlds'),
    fromPlayerId: playerId,
    fromName: v.string(),
    toPlayerId: playerId,
    text: v.string(),
    createdAt: v.number(),
    readAt: v.union(v.number(), v.null()),
  })
    .index('to', ['worldId', 'toPlayerId'])
    .index('from', ['worldId', 'fromPlayerId']),

  // Per-agent rate-limit cursors for posting / messaging / thinking (v1.2 Steps 3-4, v1.3).
  agentCommsState: defineTable({
    worldId: v.id('worlds'),
    playerId,
    lastFeedPostAt: v.optional(v.number()),
    lastDmAt: v.optional(v.number()),
    lastThoughtAt: v.optional(v.number()),
    lastArtifactAt: v.optional(v.number()),
    lastJournalAt: v.optional(v.number()),
    lastReactAt: v.optional(v.number()),
    lastPlanAt: v.optional(v.number()),
    lastGatherAt: v.optional(v.number()),
    lastFactionAt: v.optional(v.number()), // founded/joined a faction
    lastFactionMoveAt: v.optional(v.number()), // led a faction's public stance
    lastGossipAt: v.optional(v.number()), // confided a take about a third party
    lastIssueAt: v.optional(v.number()), // put a civic proposition forward
    lastLobbyAt: v.optional(v.number()), // campaigned / lobbied on the active issue
    lastReciprocateAt: v.optional(v.number()), // gave / lent / repaid / did a favor
  }).index('playerId', ['worldId', 'playerId']),

  // Shared plans / gatherings (v2.0): the world has no calendar months — time is a plain
  // world-DAY counter (see data/clock.ts). When two characters make plans in a conversation
  // ("let's grab coffee in a couple days"), we extract a single SHARED row here, anchored to an
  // absolute world-day, with BOTH of them as attendees. This is what keeps everyone on the same
  // page: instead of each agent half-remembering the plan in lossy vector memory, they all read
  // from one structured object that's injected back into their prompts as it approaches. Others
  // can join a host's gathering later. See data/plans.ts + convex/plans.ts.
  plannedEvents: defineTable({
    worldId: v.id('worlds'),
    title: v.string(),
    description: v.optional(v.string()),
    day: v.number(), // absolute world-day the gathering lands on
    hour: v.optional(v.number()), // 0..23 time of day, if one was agreed
    placeName: v.optional(v.string()),
    hostPlayerId: playerId,
    hostName: v.string(),
    attendees: v.array(v.object({ playerId, playerName: v.string() })),
    // v2.8 — who PHYSICALLY showed up: filled live as attendees reach the venue during the event
    // window. resolveDueGatherings counts THIS, not the RSVP list, so turnout is real attendance.
    present: v.optional(v.array(v.object({ playerId, playerName: v.string() }))),
    createdDay: v.number(), // world-day the plan was made
    status: v.union(v.literal('upcoming'), v.literal('happened'), v.literal('missed')),
    // v2.1: 'pair' = a plan two people made in conversation; 'gathering' = an OPEN event a host
    // threw that anyone can join. Gatherings are the influence vector — hosting one people show
    // up to grows the host's standing and spreads their beliefs (see convex/plans.ts resolve).
    kind: v.optional(v.union(v.literal('pair'), v.literal('gathering'))),
    turnout: v.optional(v.number()), // how many actually showed, set when it resolves
    createdAt: v.number(),
  })
    .index('worldId', ['worldId'])
    .index('byDay', ['worldId', 'day']),

  // Work obligation + standing (v1.9): each character's job cadence state. Scheduled workers
  // track whether they showed up today; deliverable workers track output this cycle. Falling
  // behind sets `behind` (drives stress) and accrues `standingPenalty` (subtracted from their
  // reputation until they recover). See data/work.ts + convex/work.ts.
  workState: defineTable({
    worldId: v.id('worlds'),
    playerId,
    playerName: v.string(),
    lastEvalDay: v.number(), // last world-day we ran the daily evaluation
    attendedToday: v.boolean(), // scheduled: showed up to the shift today
    cycleStartDay: v.number(), // deliverable: when the current quota cycle began
    deliverablesThisCycle: v.number(),
    behind: v.boolean(), // currently failing the obligation (drives stress + catch-up)
    standingPenalty: v.number(), // points subtracted from reputation; decays as they recover
    missedCount: v.number(), // cumulative missed shifts / short cycles
  }).index('author', ['worldId', 'playerId']),

  // Beliefs (v1.8): each character's convictions, seeded from their profile (data/beliefs.ts)
  // and evolving over time. They color the work a character makes and how they argue, and they
  // shift — slowly each night, and sharply when a controversial piece or a heated disagreement
  // lands. `conviction` is 0..100; `lastShiftAt` marks a recent change for the UI.
  beliefs: defineTable({
    worldId: v.id('worlds'),
    playerId,
    playerName: v.string(),
    topic: v.string(),
    statement: v.string(),
    conviction: v.number(),
    origin: v.union(v.literal('seed'), v.literal('evolved')),
    updatedAt: v.number(),
    lastShiftAt: v.optional(v.number()),
  }).index('author', ['worldId', 'playerId']),

  // Per-character journal (v1.7): a private, persistent first-person diary. The nightly
  // consolidation logs a reflection entry here, and characters also write voluntarily after a
  // significant conversation, after making something, when a notable event lands, or just when
  // something's on their mind. Each entry is ALSO inserted into the vector memory store (so it
  // feeds future recall + reflection) — the journal is a readable surface, not a separate brain.
  // See convex/agent/journal.ts + convex/journal.ts.
  journalEntries: defineTable({
    worldId: v.id('worlds'),
    playerId,
    playerName: v.string(),
    // What prompted the entry.
    trigger: v.union(
      v.literal('reflection'), // nightly consolidation
      v.literal('conversation'),
      v.literal('artifact'),
      v.literal('event'),
      v.literal('spontaneous'),
    ),
    // A short label for what it's about (the other person, the artifact title, the event).
    contextNote: v.optional(v.string()),
    text: v.string(),
    day: v.number(),
    createdAt: v.number(),
  }).index('author', ['worldId', 'playerId']),

  // Real work output (v1.6): when an agent works their job they sometimes produce a genuine,
  // role-specific artifact — a research note, policy memo, article, artwork, case note, etc.
  // The LLM writes real content; it persists here (surviving memory-gisting), shows in the
  // town Library, becomes a memory for the author, and can respond to what others published —
  // a discourse / progress chain. See data/artifacts.ts + convex/artifacts.ts.
  artifacts: defineTable({
    worldId: v.id('worlds'),
    authorPlayerId: playerId,
    authorName: v.string(),
    // The kind of work this is, from data/artifacts.ts (e.g. 'research note', 'policy memo').
    workType: v.string(),
    emoji: v.string(),
    title: v.string(),
    body: v.string(),
    // The title of the recent town artifact this one responds to / builds on, if any.
    respondsTo: v.optional(v.string()),
    placeName: v.optional(v.string()),
    day: v.number(), // world-day index it was made
    createdAt: v.number(),
  })
    .index('worldId', ['worldId'])
    .index('author', ['worldId', 'authorPlayerId']),

  // The Town Chronicle (v1.3): a god-view stream of gisted events — inner thoughts,
  // conversation summaries, feed posts, and (later) relationship + artifact updates.
  // The observer's readable digest; written from the existing event hooks.
  townEvents: defineTable({
    worldId: v.id('worlds'),
    ts: v.number(),
    kind: v.union(
      v.literal('thought'),
      v.literal('conversation'),
      v.literal('feed'),
      v.literal('relationship'),
      v.literal('artifact'),
      v.literal('system'),
    ),
    // The agent at the center of the event, if any.
    playerId: v.optional(playerId),
    playerName: v.optional(v.string()),
    // A second party (e.g. the other side of a conversation).
    subjectName: v.optional(v.string()),
    emoji: v.optional(v.string()),
    summary: v.string(),
  }).index('worldId', ['worldId', 'ts']),

  // The anchored day/night clock (v1.3). One row per world; see data/clock.ts + convex/clock.ts.
  // `frozen` pauses world-time when the world is frozen, so the clock stops with the sim.
  worldClock: defineTable({
    worldId: v.id('worlds'),
    epochRealMs: v.number(),
    epochWorldMs: v.number(),
    speed: v.number(),
    frozen: v.optional(v.boolean()),
  }).index('worldId', ['worldId']),

  // Per-agent vitals + economy (v1.3 energy/sleep, v1.4 food/money).
  // energy drains while awake, recharges by sleeping; food drains while awake, refills by
  // eating (which costs money); money is earned by working your job during work hours.
  agentVitals: defineTable({
    worldId: v.id('worlds'),
    playerId,
    energy: v.number(), // 0..100
    asleep: v.boolean(),
    lastConsolidatedDay: v.number(), // world-day index of the last overnight reflection
    food: v.optional(v.number()), // 0..100
    money: v.optional(v.number()),
    social: v.optional(v.number()), // 0..100 — feeling connected/supported/liked (v1.5)
    // v2.1 — the inner life. Leisure is a real need that trades off against work (drain + how
    // much its deficit hurts are set by drives). Stress + momentum are DERIVED weather (not bars
    // you fill): recomputed nightly from needs, goal progress, and relative standing, then they
    // color how the character shows up in dialogue. See convex/mood.ts + data/drives.ts.
    leisure: v.optional(v.number()), // 0..100 — fun / rest / time among people
    stress: v.optional(v.number()), // 0..100 — felt pressure (higher = more strained)
    momentum: v.optional(v.number()), // 0..100 — orientation toward goals (50 = neutral)
  }).index('playerId', ['worldId', 'playerId']),

  // Drive profiles (v2.1): each character's stable motivational weights (ambition, recognition,
  // connection, security, autonomy, craft, principle), seeded from data/drives.ts. The dial that
  // personalizes how every need, goal, and rivalry is FELT. See convex/drives.ts.
  driveProfiles: defineTable({
    worldId: v.id('worlds'),
    playerId,
    playerName: v.string(),
    profile: v.record(v.string(), v.number()), // DriveKey -> 0..100 weight
    updatedAt: v.number(),
  }).index('author', ['worldId', 'playerId']),

  // ── Mortality & lineage (v3.0) ────────────────────────────────────────────────────────────
  // The town used to be immortal and fixed at the 8 personas in data/characters.ts. These two
  // tables are what let it turn over.
  //
  // WHY A SEPARATE TABLE RATHER THAN A FLAG ON playerDescriptions: that row is the de-facto town
  // roster — civics, drives, goals, beliefs, mood and comms all enumerate it to mean "everyone".
  // It is also engine-owned (written through Game.saveDiff), and deleting it breaks survivors'
  // memory pipeline, which resolves a dead character's NAME through it (agent/memory.ts). So the
  // description row must outlive the character, and aliveness has to be recorded beside it. Every
  // roster enumerator filters on `lifecycle.status`; a dead character keeps their name and their
  // memories, and stops voting in civic issues.
  lifecycle: defineTable({
    worldId: v.id('worlds'),
    playerId,
    playerName: v.string(),
    status: v.union(v.literal('alive'), v.literal('dead')),
    // World-day index. NEGATIVE for the founding cast, who are already the ages their bios claim
    // when the world starts — one world-day is one year of a life (see data/lifecycle.ts for why
    // the identity prose forced that), so Mara at 31 is born 31 days before the seed runs. Age is
    // derived from this and never accumulated, so a missed pass costs nothing.
    bornDay: v.number(),
    // Per-agent, drawn with variance around the configured mean so a cohort seeded together does
    // not die together. Death is a rising hazard near this, not a hard cutoff on it — which means
    // most characters die a few years short of it. It is the frailty anchor, not a promise.
    lifespanDays: v.number(),
    // Childhood: before this world-day the character exists, moves and is visible, but holds no
    // conversations. Cheap on the inference budget and true to life.
    maturesDay: v.number(),
    // Derived from (age, lifespanDays) every world-day and stored only so a CHANGE is detectable.
    // Optional because rows written before aging existed have neither.
    stage: v.optional(v.union(v.literal('child'), v.literal('adult'), v.literal('elder'))),
    lastAgedDay: v.optional(v.number()),
    // Set by the world-wide daily pass when this character crosses into a new stage, and cleared by
    // that character's own night tick after they journal it. A take-and-clear handoff rather than a
    // flag, because the pass runs once for everyone (from whichever agent reaches the new day
    // first) while the journal entry has to be written in each character's own voice, later.
    pendingStageNote: v.optional(v.string()),
    diedDay: v.optional(v.number()),
    cause: v.optional(v.string()), // 'age' for now; 'starvation' once the economy pass lands
    // Lineage. Absent for the founding cast, who have no parents.
    parentA: v.optional(playerId),
    parentB: v.optional(playerId),
  })
    .index('playerId', ['worldId', 'playerId'])
    .index('status', ['worldId', 'status']),

  // Per-agent traits that USED to be derived from the display name via lookup tables in data/
  // (homeFor / workFor / jobFor / priorPole). Those tables only had entries for the 8 founding
  // personas, so a character born at runtime with a novel name fell through every one of them and
  // ended up with no home, no workplace, a stub job and no convictions — present, but not a
  // person. This is the same shape driveProfiles already uses: seeded from the name table for the
  // founding cast, read from the DB thereafter, and INHERITED (with variation) at birth.
  agentTraits: defineTable({
    worldId: v.id('worlds'),
    playerId,
    playerName: v.string(),
    homePlaceId: v.optional(v.string()),
    workplaceId: v.optional(v.string()),
    job: v.optional(
      v.object({
        kind: v.union(v.literal('scheduled'), v.literal('deliverable')),
        startHour: v.optional(v.number()),
        endHour: v.optional(v.number()),
        quota: v.optional(v.number()),
        perDays: v.optional(v.number()),
      }),
    ),
    poles: v.optional(v.record(v.string(), v.number())), // ChargedTopic -> Pole (-1 | 1)
    updatedAt: v.number(),
  }).index('playerId', ['worldId', 'playerId']),

  // Goals (v2.1): a two-tier ladder. One long-term aspiration per character (seeded from their
  // drives, a far world-day horizon) and a rolling set of short-term milestones beneath it, each
  // with a near deadline, set/refreshed during the nightly consolidation. Progress feeds mood —
  // hitting a milestone is momentum, blowing a deadline is stress. See convex/goals.ts.
  goals: defineTable({
    worldId: v.id('worlds'),
    playerId,
    playerName: v.string(),
    tier: v.union(v.literal('long'), v.literal('short')),
    text: v.string(),
    createdDay: v.number(),
    dueDay: v.number(), // world-day the goal is meant to be reached by
    status: v.union(v.literal('active'), v.literal('done'), v.literal('missed')),
    note: v.optional(v.string()), // latest progress note / how it resolved
    resolvedDay: v.optional(v.number()),
    // v2.9 goal-pursuit: how many days they actually spent effort on this, and the last such day.
    // Bumped by maybeWorkOnGoal; lets the nightly review credit goals that were genuinely worked
    // (grounding completion) and lets a goal be worked at most once per day.
    progressDays: v.optional(v.number()),
    lastProgressDay: v.optional(v.number()),
    updatedAt: v.number(),
  }).index('author', ['worldId', 'playerId']),

  // Factions (v2.3): the GROUP tier. A faction crystallizes around one bank of a charged belief
  // fault line (regulation / automation / AI safety) and takes public stances. `intensity` is how
  // hardline it currently is — it moves with what the faction DOES, and that's what members react
  // to. Two factions on the same topic are rivals (opposite banks). See data/factions.ts.
  factions: defineTable({
    worldId: v.id('worlds'),
    name: v.string(),
    topic: v.string(), // the charged topic it formed around
    pole: v.number(), // 1 | -1 — which bank of the fault line
    premise: v.string(), // one-line manifesto, founder's voice
    founderPlayerId: playerId,
    founderName: v.string(),
    foundedDay: v.number(),
    intensity: v.number(), // 0..100 — how hardline; moves with its public moves
    lastStance: v.optional(v.string()), // text of the most recent public stance
    lastMoveDay: v.optional(v.number()),
    status: v.union(v.literal('active'), v.literal('dissolved')),
    createdAt: v.number(),
  })
    .index('worldId', ['worldId'])
    .index('byTopic', ['worldId', 'topic']),

  // Faction ties (v2.3): affiliation as a LIVING FIELD, not a roster. One row per (faction,
  // character) holding a `commitment` 0..100 that moves over time — approve/disapprove of the
  // faction's moves, belief-drift realignment, and social pull. A character can hold several ties
  // at once (multiple memberships; primary = the highest). Crossing the band thresholds IS
  // joining/leaving. See data/factions.ts (the dynamics) + convex/factions.ts.
  factionTies: defineTable({
    worldId: v.id('worlds'),
    factionId: v.id('factions'),
    playerId,
    playerName: v.string(),
    commitment: v.number(), // 0..100
    role: v.union(v.literal('founder'), v.literal('member'), v.literal('curious')),
    joinedDay: v.number(), // world-day they first crossed into membership
    updatedAt: v.number(),
  })
    .index('byFaction', ['worldId', 'factionId'])
    .index('byPlayer', ['worldId', 'playerId']),

  // Reciprocity (v2.7): the horizontal economy — value moving person↔person. `exchanges` is the log
  // of gifts/loans/repayments/favors; `reciprocityLedger` is the running balance per ordered pair —
  // how much `from` OWES `to` (money borrowed not yet repaid; favors received not yet returned). Debt
  // sits on the debtor's mind and frays the bond if it lingers; repaying builds trust. See
  // data/reciprocity.ts.
  exchanges: defineTable({
    worldId: v.id('worlds'),
    fromPlayerId: playerId,
    fromName: v.string(),
    toPlayerId: playerId,
    toName: v.string(),
    kind: v.union(
      v.literal('gift'),
      v.literal('loan'),
      v.literal('repay'),
      v.literal('favor'),
    ),
    amount: v.number(), // money for gift/loan/repay; 0 for a (non-money) favor
    note: v.optional(v.string()),
    day: v.number(),
    createdAt: v.number(),
  })
    .index('worldId', ['worldId', 'createdAt'])
    .index('from', ['worldId', 'fromPlayerId'])
    .index('to', ['worldId', 'toPlayerId']),

  // Directed running balance: what `from` owes `to`. moneyDebt = unrepaid loans; favorDebt = favors
  // received and not yet returned (a soft count).
  reciprocityLedger: defineTable({
    worldId: v.id('worlds'),
    fromPlayerId: playerId, // the one who owes
    toPlayerId: playerId, // the one owed
    moneyDebt: v.number(),
    favorDebt: v.number(),
    debtSinceDay: v.optional(v.number()), // world-day the current money-debt was opened (for aging)
    updatedAt: v.number(),
  })
    .index('edge', ['worldId', 'fromPlayerId', 'toPlayerId'])
    .index('debtor', ['worldId', 'fromPlayerId'])
    .index('creditor', ['worldId', 'toPlayerId']),

  // Civic issues (v2.6): a town-wide proposition that campaigns for a few world-days and then
  // RESOLVES — winners and losers. One active issue at a time. Stances live in civicStances. The
  // proposing faction, the rival, beliefs, gossip, and standing are all inputs; the outcome lands
  // on status, mood, convictions, and faction cohesion. See data/civics.ts.
  civicIssues: defineTable({
    worldId: v.id('worlds'),
    topic: v.string(),
    favorsPole: v.number(),
    title: v.string(),
    text: v.string(),
    proposerPlayerId: playerId,
    proposerName: v.string(),
    proposerFactionId: v.optional(v.id('factions')),
    openedDay: v.number(),
    resolvesDay: v.number(),
    status: v.union(v.literal('campaigning'), v.literal('resolved')),
    // Set on resolution:
    passed: v.optional(v.boolean()),
    forWeight: v.optional(v.number()),
    againstWeight: v.optional(v.number()),
    resolvedDay: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index('worldId', ['worldId'])
    .index('byStatus', ['worldId', 'status']),

  // Where each character stands on the active issue, and how firmly (weight = turnout × intensity).
  // Seeded from their belief side + faction, then moved by persuasion during the campaign.
  civicStances: defineTable({
    worldId: v.id('worlds'),
    issueId: v.id('civicIssues'),
    playerId,
    playerName: v.string(),
    stance: v.union(v.literal('support'), v.literal('oppose'), v.literal('undecided')),
    weight: v.number(), // 0..100
    updatedAt: v.number(),
  })
    .index('byIssue', ['worldId', 'issueId'])
    .index('byPlayer', ['worldId', 'playerId', 'issueId']),

  // Gossip (v2.4): a record of one character confiding a take about an ABSENT third party to a
  // confidant. Recording it both leaves a readable trail ("word going around about C") and, at write
  // time, nudges the listener's view of the subject — scaled by how much the listener trusts the
  // speaker. This is how third-party reputation propagates transitively. See data/gossip.ts.
  gossipEvents: defineTable({
    worldId: v.id('worlds'),
    speakerPlayerId: playerId,
    speakerName: v.string(),
    listenerPlayerId: playerId,
    listenerName: v.string(),
    subjectPlayerId: playerId,
    subjectName: v.string(),
    valence: v.number(), // +1 warm (talking them up) / -1 cool (running them down)
    line: v.string(), // what was actually said
    day: v.number(),
    createdAt: v.number(),
  })
    .index('worldId', ['worldId', 'createdAt'])
    .index('bySubject', ['worldId', 'subjectPlayerId'])
    .index('byListener', ['worldId', 'listenerPlayerId']),

  // The relationship graph (v1.5): a directed edge per ordered pair, holding how `from` feels
  // about `to` across a few dimensions. Updated from conversation outcomes and persisting as
  // numbers even after the conversation text is gisted away. Reputation is derived from the
  // inbound edges (see convex/relationships.ts).
  relationships: defineTable({
    worldId: v.id('worlds'),
    fromPlayerId: playerId,
    toPlayerId: playerId,
    familiarity: v.number(), // 0..100 — how well they know them
    affinity: v.number(), // 0..100 — warmth / liking (50 = neutral)
    respect: v.number(), // 0..100 — esteem (50 = neutral)
    trust: v.number(), // 0..100 (50 = neutral)
    romantic: v.number(), // 0..100 — romantic feeling (0 = none)
    updatedAt: v.number(),
  })
    .index('edge', ['worldId', 'fromPlayerId', 'toPlayerId'])
    .index('inbound', ['worldId', 'toPlayerId'])
    .index('outbound', ['worldId', 'fromPlayerId']),

  ...agentTables,
  ...aiTownTables,
  ...engineTables,
});
