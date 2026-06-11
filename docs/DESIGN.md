# Terrarium — design (v0.1)

A pixel-world simulation, forked from **AI Town** (`a16z-infra/ai-town`, MIT), that
models **two kinds of inhabitants**:

1. **Humans** (AI-played) — embodied villagers who walk the town, talk, gossip about
   the world (news, politics, culture, social issues), and use AI to build things.
2. **AI agents** (native AI, *not embodied*) — they live "in the computer," not as
   sprites on the map. Humans interact with them via a terminal/device; the AIs can
   also talk to each other, do work, and (later) spawn sub-agents.

The point: a watchable little world where we **gradually introduce / test directions
AI development could grow toward** — agent↔agent communication, agents spawning
agents, autonomous goals — alongside ordinary human↔AI work and chat.

---

## Why AI Town as the base
- **PixiJS pixel frontend** = the "watch it like a little world" UI, for free.
- **Convex backend** handles world state, the agent loop, scheduling, vector search,
  and live frontend sync — huge infra savings.
- **Multi-provider LLM** already (Ollama / OpenAI / Anthropic / Together / Groq).
- MIT, ~10k★, actively maintained, explicitly "meant to be extended."

Ruled out: **Project Sid** (Altera) is conceptually closest but **not open-sourced**;
the **Stanford original** is the canonical reference but less forkable than AI Town.

---

## The core fork: two agent classes

AI Town ships **one** class (embodied villagers). We add a second.

| | Humans | AI agents |
|---|---|---|
| Embodied? | yes (sprite walks the map) | **no** — rendered in a "cloud / server-room" zone |
| Played by | local OSS model (they're "people") | their **real provider** (Claude, ChatGPT, …) |
| Powers | talk, move, work | talk, **agent↔agent**, **spawn sub-agents**, work |
| Memory | AI Town native (→ Eve-lite in v1.2) | Eve-lite from the start (coherence matters most) |

Visual idea: AIs as nodes in an off-map "cloud" zone; link-lines light up on
human↔AI and AI↔AI exchanges, so the invisible AI activity is watchable.

---

## Compute plan (the move that makes a 16GB M4 viable)

The AIs are *supposed to be* Claude/ChatGPT/etc., so they **should** call those APIs —
that's thematically correct, not a workaround. So **only the humans run locally.**

- **Humans → local Ollama** model on the Mac Mini (Qwen2.5-7B or Llama-3.1-8B, Q4).
- **AIs → real provider APIs** (Anthropic, OpenAI, DeepSeek, …), model-typed per agent.

### Hard constraint — embeddings must be uniform
AI Town's `EMBEDDING_DIMENSION` (`convex/util/llm.ts`) is **global**; the
`memoryEmbeddings` vector index can hold only one dimension. So:
- **Chat/generation model = per-agent** (local for humans, API for AIs). ✅ supported by forking the global provider switch into a per-agent one.
- **Embedding model = ONE provider for everyone** — use **local Ollama embeddings
  (1024-dim)** for all memory regardless of who generated it. Keeps the vector store
  consistent *and* embeddings free/local.

### M4 16GB reality (set expectations)
- ~12–18 tok/s generation; **prefill of long memory prompts is the latency cost**.
  Budget ~20–40s per human turn → a **slow ambient world**, not real-time.
- RAM is tight: model (~6GB) + macOS + Convex/Node + browser ≈ 12–15GB. **View the
  pixel frontend from the laptop** (point it at the Mini); don't render on the same box.
- Dev loop: start **3 humans + 1 AI**, scale to 7+4 once stable.
- Tuning knobs in `convex/constants.ts`: `NUM_MEMORIES_TO_SEARCH` (keep low → shorter
  prompts), conversation cooldowns / `MAX_CONVERSATION_MESSAGES`, tick cadence.

---

## Eve-lite memory (v1.2) — borrow the cheap 20%, skip the heavy 80%

AI Town memory (`convex/agent/memory.ts`) is the **Stanford recipe**: embed every
conversation → `searchMemories` ranks by relevance + recency + importance → periodic
`reflectOnMemories`. Workable but shallow (no supersession, no belief revision) — the
exact profile Eve improves on.

**Do NOT port** Eve's expensive parts (each = extra LLM calls/turn, brutal on a local
8B): dual conscious/subconscious loop, hierarchical consolidation, belief-revision
passes, phantom-claim checker.

**DO port these four — they're retrieval/bookkeeping logic, ~zero extra LLM cost:**

1. **Supersession on knowledge-update** — when a new memory contradicts an old fact
   (same entity+attribute), mark the old one stale instead of letting both float.
   *Fixes the #1 AI Town incoherence (stale + fresh retrieved together).*
   → hook in `rememberConversation` (`memory.ts`).
2. **Entity-scoped retrieval** — index memories by who/what they're about; let recall
   filter to "memories about Bob," not blind vector similarity.
   → augment `searchMemories` with an entity tag + filter.
3. **Hybrid keyword + semantic recall** — add a lexical match alongside the existing
   vector search (Eve learned keyword recall carries real weight).
   → `searchMemories`.
4. **Pinned identity tier** — load-bearing self/relationship facts that never decay
   out of retrieval.
   → a `pinned` flag on memories; always include in the candidate set.

All four are metadata + filter changes. No new per-turn model calls.

---

## v1 cast
- **7 humans** — distinct identities/plans in `data/characters.ts`, reacting to a
  **world feed** (news/politics/culture/social issues) injected as ambient events.
- **4 AIs**, model-typed: **Claude**, **ChatGPT (GPT)**, **DeepSeek** (cheap), and one
  **local OSS / reasoning subtype** — so model-personality differences can emerge.

## "AI-development directions" as a tech tree (feature flags)
Flip on over time to test a direction:
`human↔AI chat+work` → `agent↔agent comms` → `agent spawns sub-agent` →
`autonomous goals` → …

---

## Staged roadmap
- **v1.0** — base AI Town loop, **3 humans on local 8B**, native memory, pixel
  frontend viewed from laptop. Confirm the world breathes.
- **v1.1** — add the **4 AIs on real APIs** (per-agent model switch), scale humans to 7,
  add the world feed + the AI "cloud" zone visualization.
- **v1.2** — drop in the **Eve-lite retrieval layer** (supersession + entity-scoped +
  hybrid recall + pinned tier), AIs first.
- **later** — tech-tree flags (agent↔agent, spawning, autonomous goals).

## Open decisions
1. Convex **cloud dev** (offloads DB off the Mini → lighter RAM; needs login) vs local
   self-host. → lean **cloud dev** for v1.
2. AIs visualized as a **server-room zone** (rec) vs pure chat-panel overlay.
3. Eve-lite spec: have **sill/joist** review, since it's a deliberate subset of Eve.

---
*Upstream: https://github.com/a16z-infra/ai-town — `git fetch upstream` to pull updates.*
