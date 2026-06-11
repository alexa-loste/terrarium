# Running Terrarium on the Mac Mini (M4, 16GB)

Goal: clone this repo onto the Mini, run the humans on a local model via Ollama, view
the pixel world from your laptop. (AI agents call real provider APIs — added in v1.1.)

## 0. One-time prereqs (on the Mini)
```sh
# Node (v18+; v26 confirmed working on the Air). Homebrew:
brew install node
# Ollama (local model runtime)
brew install ollama        # or download from https://ollama.com
ollama serve &             # starts the local server on :11434
# Pull a 16GB-friendly model + an embedding model (uniform embeddings — see DESIGN.md)
ollama pull qwen2.5:7b     # ~5GB Q4; or: ollama pull llama3.1:8b
ollama pull mxbai-embed-large   # 1024-dim embeddings (matches AI Town's Ollama default)
```

## 1. Clone + install
```sh
git clone https://github.com/alexa-loste/terrarium.git
cd terrarium
npm install
```

## 2. Convex backend
`npm run dev` will prompt a Convex login the first time. **Use Convex cloud dev** for
v1 — it keeps the database off the Mini (saves RAM; the Mini just runs the model +
frontend). Follow the prompt to create/select a project.

## 3. Point it at the local model
AI Town reads the provider from env. For all-local (humans) defaults:
```sh
# Ollama is the default when no OPENAI/TOGETHER key is set, but be explicit:
npx convex env set LLM_PROVIDER ollama
npx convex env set OLLAMA_MODEL qwen2.5:7b        # if your fork reads this; else edit convex/util/llm.ts
# If the Mini runs Ollama on a non-default host:
# npx convex env set OLLAMA_HOST http://127.0.0.1:11434
```
> Note: `EMBEDDING_DIMENSION` in `convex/util/llm.ts` must match the embedding model
> (Ollama `mxbai-embed-large` = **1024**). Don't mix embedding providers — see DESIGN.md.

## 4. Run
```sh
npm run dev          # frontend (vite :5173) + backend together
# or split:  npm run dev:frontend   /   npm run dev:backend
```

## 5. Watch from your laptop (don't render on the Mini)
Expose Vite on the LAN and open it from the Air:
```sh
npm run dev:frontend -- --host    # vite serves on 0.0.0.0
```
Then on the laptop browse to `http://<mini-LAN-ip>:5173`. (Find the IP with
`ipconfig getifaddr en0` on the Mini.) This keeps the Mini's RAM for the model.

## 6. Tune for 16GB / slow ambient pace (`convex/constants.ts`)
- Start small: edit `data/characters.ts` down to **3 humans** for the first run.
- Keep `NUM_MEMORIES_TO_SEARCH` low (default 3) → shorter prompts → faster prefill.
- Longer cooldowns / fewer concurrent conversations = fewer simultaneous model calls
  (a single local model serializes calls).

## Troubleshooting
- **Out of memory / swap thrash** → fewer characters, smaller model (`qwen2.5:7b` →
  a 3–4B), or close the browser on the Mini (view from the laptop).
- **Slow** → expected. It's a slow ambient world on a base M4; that's the trade for
  free/local compute. The AIs (v1.1) hit fast APIs, so they won't be the bottleneck.
- **Embedding dimension error** → your embedding model ≠ `EMBEDDING_DIMENSION`. Make
  them match (Ollama mxbai = 1024).
