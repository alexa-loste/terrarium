import { useState } from 'react';
import { useQuery } from 'convex/react';
import { api } from '../../convex/_generated/api';

// v1.3 — the Town Chronicle: a readable god-view log of gisted events (inner thoughts,
// conversation summaries, feed posts; relationship + artifact events arrive in later slices).
// Lives on the left so it doesn't collide with the clock (top-left corner) or Feed (right).

type Kind = 'thought' | 'conversation' | 'feed' | 'relationship' | 'artifact' | 'system';

const KIND_STYLE: Record<Kind, { cls: string; verb: (s?: string) => string }> = {
  thought: { cls: 'border-l-sky-400', verb: () => 'is thinking' },
  conversation: { cls: 'border-l-emerald-400', verb: (s) => (s ? `talked with ${s}` : 'talked') },
  feed: { cls: 'border-l-amber-400', verb: () => 'posted' },
  relationship: { cls: 'border-l-pink-400', verb: () => '' },
  artifact: { cls: 'border-l-purple-400', verb: () => 'made something' },
  system: { cls: 'border-l-brown-400', verb: () => '' },
};

export default function ChroniclePanel() {
  const [open, setOpen] = useState(false);
  const worldStatus = useQuery(api.world.defaultWorldStatus);
  const worldId = worldStatus?.worldId;
  const events = useQuery(api.townLog.listChronicle, worldId ? { worldId } : 'skip');

  return (
    <>
      <button
        onClick={() => setOpen((o) => !o)}
        title="The Town Chronicle"
        className="pointer-events-auto absolute right-36 top-3 z-40 flex items-center gap-2 rounded-full border-2 border-brown-900 bg-clay-700 px-3 py-1.5 text-sm text-white shadow-solid"
      >
        📖 Chronicle
        {events && events.length > 0 && (
          <span className="rounded-full bg-black/40 px-1.5 text-xs">{events.length}</span>
        )}
      </button>

      {open && (
        <div className="pointer-events-auto absolute bottom-3 left-3 top-28 z-40 flex w-[380px] max-w-[90vw] flex-col overflow-hidden rounded-xl border-4 border-brown-900 bg-brown-800 text-brown-100 shadow-2xl">
          <div className="flex items-center justify-between border-b-2 border-brown-900 px-4 py-2">
            <span className="font-display text-xl">The Town Chronicle</span>
            <button onClick={() => setOpen(false)} className="text-brown-200 hover:text-white">
              ✕
            </button>
          </div>

          <div className="flex-1 space-y-2 overflow-y-auto px-3 py-3">
            {!events && <div className="text-sm text-brown-300">Loading…</div>}
            {events && events.length === 0 && (
              <div className="text-sm text-brown-300">
                Quiet so far. As people think, talk, and post, the gist of it shows up here.
              </div>
            )}
            {events?.map((e) => {
              const style = KIND_STYLE[e.kind as Kind] ?? KIND_STYLE.system;
              return (
                <div
                  key={e._id}
                  className={`rounded-r-md border-l-4 bg-brown-900/40 py-1.5 pl-2.5 pr-2 ${style.cls}`}
                >
                  <div className="flex items-baseline gap-1.5">
                    <span>{e.emoji ?? '•'}</span>
                    {e.playerName && <span className="font-bold">{e.playerName}</span>}
                    <span className="text-xs text-brown-300">{style.verb(e.subjectName)}</span>
                    <span className="ml-auto text-[10px] text-brown-400">
                      {new Date(e.ts).toLocaleTimeString([], {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </span>
                  </div>
                  <div
                    className={`mt-0.5 whitespace-pre-wrap text-sm leading-snug ${
                      e.kind === 'thought' ? 'italic text-brown-200' : ''
                    }`}
                  >
                    {e.summary}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
}
