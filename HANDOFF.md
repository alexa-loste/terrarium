# TERRARIUM — handoff for whoever picks this up next

Written 2026-08-21 by lath, at `c8e4dd9`, on being reassigned off the lane.
Committed on purpose: my working contract lived in an **untracked** file on one
laptop, so the code travelled and the reasoning did not. This is the fix.

Not a changelog. Everything here is either an artifact you can re-check in one
command, or a plainly-labelled assumption.

---

## Read this first

**Durable knowledge for this project is in Eve, in the `terrarium` cortex** —
which is CANONICAL per alexa's 2026-08-12 plan (memory `b65ec877`), with
satellites in `pith`, `sill`, `lath`.

⚠️ **That cortex is current only through 2026-07-30.** The entire birth-and-death
lane (2026-08-19 → 08-21, everything below) was banked to `lath` and `lab`
instead and has NOT been ported. If you read the terrarium cortex alone you will
not know that mortality shipped. The mechanism entries worth pulling:
`ad0d5180` (lane state), `9e8a6d28` (alexa's design decisions), and in `lab`:
`29292367`, `b1da3faf`, `959c1536`, `a2c979c4`, `26b484dd`.

⚠️ Two auto-consolidation artifacts exist and should not be trusted: `8c670c0c`
and `497222cc` are duplicates of one another, and `d304375f` is a bad
cross-project merge (it fuses Eve-product onboarding and child *accounts* with
terrarium mortality, on the word "child").

## Topology, and the trap in it

- Repo `~/Desktop/terrarium` on the laptop; **the LIVE tree is `~/terrarium` on
  alexas-mac-mini** (tailnet `100.81.126.33`), which is where `convex dev` and
  vite actually run. An edit on the laptop reaches nobody until pushed and pulled.
- Convex deployment `dev:helpful-dog-720`. World `m17ak02bk4cn9p4hbehx6whfts88fw4c`.
- LLM is Ollama `deepseek-v2:16b` on the mini via ngrok — **one slot, serialized**.
- Branch `origin/mortality`. Both trees clean and matching at `c8e4dd9`.

**Test invocation: `npm test`.** Bare `npx jest` reports "0 total" and reads
exactly like a broken suite. `npm run lint` cannot run on this repo at all
(pre-existing: ESM `.eslintrc.js` under ESLint 8). `npx tsc --noEmit -p .`
should show exactly one error, `src/components/PixiGame.tsx(27,27)`, also
pre-existing. Current: **168 tests, 9 suites, green.**

## The unit decision, so it is not re-litigated

**ONE WORLD-DAY IS ONE YEAR OF A CHARACTER'S LIFE.** Not a preference. The
founding bios open in the first person with an age in years ("I'm Mara, 31"),
that text is read to the model as self-description on every prompt, and the world
counts only days. Anything slower makes the prose lie. Full reasoning in
`data/lifecycle.ts`. Age is DERIVED from `bornDay`, never accumulated, so a
missed pass costs nothing.

## What is built

| sha | what |
|---|---|
| `d45c5a4` | two live bug fixes — an engine-fatal orphan throw, and an age vacuum deleting memories |
| `bad4cf4` | mortality schema (`lifecycle`, `agentTraits`) + a `die` input removing player AND agent |
| `1a49987` | traits conversion — 43 call sites, name-keyed lookups → per-agent DB rows |
| `cc64551` | **aging** — ages, stages, the daily pass |
| `62aa6b3` | **the engine unwedged** — input numbering had restarted below its own watermark |
| `a2fe3b8` | **mortality** — death of old age; the dead stop voting in civics |
| `dc4042c` | an idle world was still advancing its calendar with nobody ticking |
| `9fc9bf7` | **age reaches the prompt** — bio age kept current in place; elders know |
| `43f7151` | **the witness memory** — survivors remember the dead, graded by closeness |
| `f6aedec` `fed5eb4` `41b5a43` | the appraisal scored warmth negative for everything; its parser read labelled replies in the wrong ORDER; the model needed asking for the format it actually produces |
| `f64d79a` | **the world clock ran backwards** — re-anchor at the EFFECTIVE speed |
| `c8e4dd9` | `clock:clockHealth`, a read-only drift probe for the above |

## What is NOT built, and what is NOT verified

- ⛔ **No children.** There is scaffolding and no mechanism: the schema has
  `parentA`/`parentB`, `maturesDay` and a `child` stage, and the whole traits
  conversion was done so a newborn could be a real person rather than a
  name-lookup miss. But `lifeInputs` contains exactly one handler — `die`. There
  is no birth input, no conception, no gestation. **`maturesDay` is written and
  never read**: the "children hold no conversations" rule is a comment in
  `convex/schema.ts` and is enforced nowhere.
- ⛔ **No pairing, and the blocker is one point.** `romantic` rises only when
  affinity **> 65**; the belief-alignment reset's structural ceiling is **64**.
  `TOPIC_POLE` in `data/factions.ts` is sparse — only one of eight characters
  holds a side on all three charged topics — and the scorer awards ±7 per
  *shared* topic from a base of 50, so the best overlap any pair can reach is two
  topics. The seed cannot open its own gate. Affinity must climb ≥2 through
  conversation, which is at least possible now the appraisal is fixed. Three ways
  out, all alexa's call: lower the gate, widen `TOPIC_POLE`, or let conversation
  do it.
- ⚠️ **THE DEATH PATH HAS NEVER RUN.** `kill`, the `die` dispatch,
  `resweepRecentDead` and the civics filter are Convex-side, have no unit test,
  and no character has died. This is the single biggest unverified thing here.
- **Not covered:** whether the 04:20 UTC vacuum actually spares memories. The fix
  is deployed and the tables are off the list, but I have no direct evidence of a
  run.

## Hard holds — do not do these without alexa pressing play

1. **Do NOT run `lifecycle:forceDeath`.** She ruled 2026-08-20: wait for a
   natural death. Death is permanent — player ids are never reused
   (`world.nextId` only increments).
2. Deploy/reset decisions on her word, not a peer's.

## Where the next death is

At day 426 **every hazard in town is 0.000000** — the clock rewind took everyone
out of the elder band. Desmond (45/75) is nearest and is 20 world-days from elder
onset. Simulating the real `deathHazard` over 20k runs of the current roster:
first death **median 29 world-days** (p10 26, p90 32).

**One world-day is 24 real minutes at speed 1, and only while someone is
watching** — the freeze fix stops an unwatched world's clock. So that median is
~11.6h of watched time at speed 1, ~1.5h at speed 8.

Re-read the roster rather than quoting this: `npx convex run lifecycle:roster`.

## How many characters can this hold

**No hard cap in the code.** `MAX_HUMAN_PLAYERS = 8` caps browser-joined humans
only and has nothing to do with AI characters. Two soft ceilings: there are **8
sprites** (`f1`–`f8`) and `Player.join` checks a sprite *exists*, not that it is
unique, so >8 works with shared appearances; and **the single-slot local LLM is
the real limit**. `ACTION_TIMEOUT` is already raised 60s→120s and
`MAX_CONVERSATION_DURATION` 2min→10min "for local dev" because it is tight at 8.
From the constants — ~7–10s per message round-trip, `MAX_CONVERSATION_MESSAGES
= 8`, at most N/2 conversations at once — **~12–16 characters before
conversations start missing their timeouts. That is an estimate from constants,
NOT a measurement.** Measure it before relying on it.

## Traps that cost me real time

- **Measure the function, don't infer from a symptom's cadence.** I blamed
  `ACTION_TIMEOUT` for a stuck conversation off a ~120s message cadence; timing
  the function gave 7–10s and killed the theory. The real cause was in the engine
  row. The cadence was real and the explanation was wrong.
- **A fix that works does not validate the story you told about why.** I invented
  three causes in one session and wrote two of them into permanent code comments.
  Two minutes of reverting the change would have caught each.
- **An instrument carrying its own copy of the logic measures a parser nobody
  runs.** My appraisal calibration reported 5/5 green while the live path was
  scrambling labelled replies, because it had a private copy of the parser and
  scored an unparseable reply as neutral. It now calls the real parser and fails
  on unparsed. Re-run `relationships:calibrateAssessment` after ANY edit to the
  wording and after changing the model.
- **A mutation's returned count is not a witness.** `{"seeded": 56}` says 56 rows
  were TOUCHED, not that any value changed. Dump before and after.
- **Two checkouts.** `~/Desktop/terrarium` vs `~/terrarium`. Confirm which tree
  the running process was launched from before believing a result.

## Flagged, not fixed

- **No decay on any relationship field.** The reset knocked familiarity off 100
  (to 25) and respect off its ceiling, but nothing pulls them back down, so they
  will re-saturate. The reset bought time; it did not fix the ratchet.
- `findConversationCandidate` (`convex/aiTown/agent.ts`) pushes the SEEKER's own
  `position` for every candidate, so the distance sort is inert and "nearest" is
  really "first in world-map order". One line. Deliberately kept out of the
  engine commit.
- `data/economy.ts` (`wageFor`, `costOfLivingFor`, `dailySavingsFor`),
  `driveSeedFor` and `seedBeliefsFor` are still **name-keyed** with the same
  defect the traits conversion fixed — a newborn gets default wages. Becomes
  load-bearing exactly when the economy is tightened for starvation.
- `agentTraits` stores a home as an ID into a static array, so a newborn can
  INHERIT a home but cannot be given a new one.

## alexa's settled design decisions — do not re-litigate

Death by old age FIRST (starvation deferred: agents hold 126–4078 money against a
4–16 meal, so hunger provably cannot bite until the economy is tightened —
measured, not assumed). Memories persist after death. Children come from a
relationship between two agents. A child inherits NO memories except what a
parent tells them, so there is no inheritance mechanism to build. Agents ARE
aware they are dying. Gestation delay, not instant spawn. A childhood phase with
no conversations.

**Next, in order:** pairing → gestation → childhood.
