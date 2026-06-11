# 🌱 Terrarium

A pixel-world sim — humans (AI-played) **and** non-embodied AI agents — for watching
directions AI development could grow toward. Forked from
[AI Town](https://github.com/a16z-infra/ai-town) (MIT).

- **Design / plan of record:** [`docs/DESIGN.md`](docs/DESIGN.md)
- **Run it on the Mac Mini (M4, 16GB):** [`docs/SETUP-MINI.md`](docs/SETUP-MINI.md)
- **Upstream AI Town docs:** [`README.md`](README.md)

## Status: v1.0 scaffolding
- [x] Forked AI Town base → private repo
- [x] Starter HUMANS (3) in `data/characters.ts` (scale to 7 in v1.1)
- [ ] Boot base loop on the Mini (Ollama + local 8B), view from laptop
- [ ] v1.1 — add 4 model-typed AI agents (real APIs) + world feed + AI "cloud" zone
- [ ] v1.2 — Eve-lite memory layer (supersession, entity-scoped, hybrid recall, pinned)

Build on git here; deploy to the Mini by cloning. See the design doc for the compute
split (humans local, AIs on real APIs) and the Eve-lite memory plan.
