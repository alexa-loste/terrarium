import { useEffect, useState } from 'react';
import { useMutation, useQuery } from 'convex/react';
import { api } from '../../convex/_generated/api';
import { Id } from '../../convex/_generated/dataModel';
import {
  SPEED_OPTIONS,
  WorldClock as ClockAnchor,
  clockLabel,
  nightOverlayAlpha,
  phaseEmoji,
  worldTime,
} from '../../data/clock';

// v1.3 — the on-screen day/night clock + speed toggle, plus a night tint over the map.
// The clock is derived from an anchor (see data/clock.ts), so we fetch the anchor once and
// advance the displayed time locally each second; changing speed re-anchors server-side and
// the query updates reactively.
export default function WorldClock({ worldId }: { worldId: Id<'worlds'> }) {
  const clock = useQuery(api.clock.getClock, { worldId });
  const setSpeed = useMutation(api.clock.setSpeed);

  // Skew between server and browser clocks, captured when the anchor arrives.
  const [skew, setSkew] = useState(0);
  const [, forceTick] = useState(0);

  useEffect(() => {
    if (clock) setSkew(clock.now - Date.now());
  }, [clock?.now]);

  useEffect(() => {
    const id = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);

  if (!clock) return null;
  const anchor: ClockAnchor = {
    epochRealMs: clock.epochRealMs,
    epochWorldMs: clock.epochWorldMs,
    speed: clock.speed,
  };
  const t = worldTime(anchor, Date.now() + skew);
  const alpha = nightOverlayAlpha(t);

  return (
    <>
      {/* Night tint — a cool wash that deepens at night, lifts at dawn. */}
      <div
        className="pointer-events-none absolute inset-0 z-10 transition-colors duration-1000"
        style={{ backgroundColor: `rgba(20, 24, 64, ${alpha.toFixed(3)})` }}
      />
      {/* Clock badge + speed toggle, top-left of the map. */}
      <div className="pointer-events-auto absolute left-3 top-3 z-30 flex items-center gap-2 rounded-lg border-2 border-brown-900 bg-clay-700/90 px-3 py-1.5 text-white shadow-solid">
        <span className="text-lg leading-none">{phaseEmoji(t.phase)}</span>
        <span className="font-display text-sm tracking-wide tabular-nums">{clockLabel(t)}</span>
        <span className="mx-1 h-4 w-px bg-brown-900/60" />
        <div className="flex items-center gap-1">
          {SPEED_OPTIONS.map((s) => (
            <button
              key={s}
              onClick={() => void setSpeed({ worldId, speed: s })}
              title={`${s}× world time`}
              className={
                'rounded px-1.5 py-0.5 text-xs font-bold leading-none transition-colors ' +
                (clock.speed === s
                  ? 'bg-white text-clay-700'
                  : 'bg-brown-900/40 text-white hover:bg-brown-900/70')
              }
            >
              {s}×
            </button>
          ))}
        </div>
      </div>
    </>
  );
}
