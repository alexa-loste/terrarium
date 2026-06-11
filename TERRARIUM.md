# 🌱 Terrarium

A pixel-world sim — humans (AI-played) **and** non-embodied AI agents — for watching
directions AI development could grow toward. Forked from
[AI Town](https://github.com/a16z-infra/ai-town) (MIT).

- **Design / plan of record:** [`docs/DESIGN.md`](docs/DESIGN.md)
- **Run it on the Mac Mini (M4, 16GB):** [`docs/SETUP-MINI.md`](docs/SETUP-MINI.md)
- **Upstream AI Town docs:** [`README.md`](README.md)

## Status
- [x] Forked AI Town base → private repo
- [x] Base loop running on the Mini (Ollama + local 8B), viewed from laptop ✅
- [x] **v1.1 content** — 8-person SF-2026 cast, places, 14-day events timeline, richer
      activities. Spec: [`docs/V1.1-WORLD.md`](docs/V1.1-WORLD.md)
- [ ] **v1.1 mechanics** (chunks, test each on the Mini): A fields → B clock → E events →
      C places → **D the AI-agent work loop** ⭐
- [ ] v1.2 — Eve-lite memory layer (supersession, entity-scoped, hybrid recall, pinned)

Build on git here; deploy to the Mini by cloning. See the design doc for the compute
split (humans local, AIs on real APIs) and the Eve-lite memory plan.
