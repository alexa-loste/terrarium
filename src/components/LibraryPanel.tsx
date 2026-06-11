import { useState } from 'react';
import { useQuery } from 'convex/react';
import { api } from '../../convex/_generated/api';

// v1.6 — the town Library: every real artifact the agents have produced by working their jobs
// (research notes, policy memos, articles, artwork, case notes…). Click one to read the full
// piece. This is the tangible output of "work" — and the substrate agents respond to.
// Button sits left of the Chronicle button; the reading panel opens on the right.

export default function LibraryPanel() {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const worldStatus = useQuery(api.world.defaultWorldStatus);
  const worldId = worldStatus?.worldId;
  const works = useQuery(api.artifacts.listArtifacts, worldId ? { worldId } : 'skip');

  const open_ = works?.find((w) => w._id === selected) ?? null;

  return (
    <>
      <button
        onClick={() => setOpen((o) => !o)}
        title="The town Library — everything people have made by working"
        className="pointer-events-auto absolute right-72 top-3 z-40 flex items-center gap-2 rounded-full border-2 border-brown-900 bg-clay-700 px-3 py-1.5 text-sm text-white shadow-solid"
      >
        📚 Library
        {works && works.length > 0 && (
          <span className="rounded-full bg-black/40 px-1.5 text-xs">{works.length}</span>
        )}
      </button>

      {open && (
        <div className="pointer-events-auto absolute bottom-3 right-3 top-28 z-40 flex w-[420px] max-w-[92vw] flex-col overflow-hidden rounded-xl border-4 border-brown-900 bg-brown-800 text-brown-100 shadow-2xl">
          <div className="flex items-center justify-between border-b-2 border-brown-900 px-4 py-2">
            <span className="font-display text-xl">
              {open_ ? open_.emoji + ' ' + open_.workType : 'The Library'}
            </span>
            <button
              onClick={() => (open_ ? setSelected(null) : setOpen(false))}
              className="text-brown-200 hover:text-white"
            >
              {open_ ? '← back' : '✕'}
            </button>
          </div>

          {/* Reading view: one full artifact. */}
          {open_ ? (
            <div className="flex-1 overflow-y-auto px-4 py-4">
              <h3 className="font-display text-lg leading-tight">{open_.title}</h3>
              <div className="mt-1 text-xs text-brown-300">
                by <span className="font-bold text-brown-100">{open_.authorName}</span>
                {open_.placeName ? ` · at ${open_.placeName}` : ''} · day {open_.day}
              </div>
              {open_.respondsTo && (
                <div className="mt-2 rounded border-l-4 border-l-purple-400 bg-brown-900/40 px-2 py-1 text-xs italic text-brown-200">
                  In response to “{open_.respondsTo}”
                </div>
              )}
              <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed">{open_.body}</p>
            </div>
          ) : (
            // List view: every work, newest first.
            <div className="flex-1 space-y-2 overflow-y-auto px-3 py-3">
              {!works && <div className="text-sm text-brown-300">Loading…</div>}
              {works && works.length === 0 && (
                <div className="text-sm text-brown-300">
                  Nothing made yet. As people work their jobs during the day, the things they
                  produce — notes, articles, art, memos — collect here.
                </div>
              )}
              {works?.map((w) => (
                <button
                  key={w._id}
                  onClick={() => setSelected(w._id)}
                  className="block w-full rounded-r-md border-l-4 border-l-purple-400 bg-brown-900/40 py-1.5 pl-2.5 pr-2 text-left hover:bg-brown-900/70"
                >
                  <div className="flex items-baseline gap-1.5">
                    <span>{w.emoji}</span>
                    <span className="font-bold">{w.authorName}</span>
                    <span className="text-xs text-brown-300">· {w.workType}</span>
                    <span className="ml-auto text-[10px] text-brown-400">day {w.day}</span>
                  </div>
                  <div className="mt-0.5 text-sm font-display leading-snug">{w.title}</div>
                  {w.respondsTo && (
                    <div className="mt-0.5 text-[11px] italic text-brown-400">
                      ↳ re: {w.respondsTo}
                    </div>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </>
  );
}
