import { characters } from '../../data/characters.ts';
import { GameId } from '../../convex/aiTown/ids.ts';

export type RosterEntry = {
  id: GameId<'players'>;
  name: string;
  character: string;
  // Live status emoji: 💬 speaking, 💭 thinking, 😴 asleep, or the current activity emoji.
  status?: string;
  // v1.3 vitals: energy 0..100 and whether they're currently asleep.
  energy?: number;
  asleep?: boolean;
  // v1.4 economy: food 0..100 and money (wallet).
  food?: number;
  money?: number;
  // v1.5 social: 0..100 — feeling connected / supported / liked.
  social?: number;
  // v1.5 reputation: standing in town (how others feel about them; can be negative).
  prestige?: number;
};

// Bar color: green when full, amber mid, red when running low.
function barColor(value: number): string {
  if (value > 60) return 'bg-emerald-400';
  if (value > 30) return 'bg-amber-400';
  return 'bg-red-400';
}

function Bar({ icon, value, color, label }: { icon: string; value: number; color: string; label: string }) {
  return (
    <div className="flex items-center gap-0.5" title={`${label} ${Math.round(value)}%`}>
      <span className="w-2.5 text-center text-[8px] leading-none">{icon}</span>
      <div className="h-1 w-9 overflow-hidden rounded-full bg-black/50">
        <div
          className={`h-full rounded-full ${color}`}
          style={{ width: `${Math.max(0, Math.min(100, value))}%` }}
        />
      </div>
    </div>
  );
}

// Pull the front-facing ("down") frame out of a character's spritesheet so we can crop a
// little portrait straight from the shared sprite PNG — no extra art needed.
function face(character: string) {
  const c = characters.find((x) => x.name === character);
  const frame = (c?.spritesheetData?.frames as any)?.down?.frame;
  if (!c || !frame) return null;
  return { url: c.textureUrl, x: frame.x as number, y: frame.y as number };
}

export default function CharacterRoster({
  players,
  selectedId,
  onSelect,
}: {
  players: RosterEntry[];
  selectedId?: GameId<'players'>;
  onSelect: (id: GameId<'players'>) => void;
}) {
  if (players.length === 0) return null;
  return (
    <div className="pointer-events-auto absolute bottom-3 left-1/2 z-20 flex max-w-[92vw] -translate-x-1/2 gap-1.5 overflow-x-auto rounded-2xl border-2 border-brown-900 bg-black/55 px-3 py-2 shadow-2xl backdrop-blur-sm">
      {players.map((p) => {
        const f = face(p.character);
        const selected = p.id === selectedId;
        return (
          <button
            key={p.id}
            onClick={() => onSelect(p.id)}
            title={p.name}
            className={`flex shrink-0 flex-col items-center gap-1 rounded-lg p-1 transition ${
              selected ? 'bg-yellow-400/30 ring-2 ring-yellow-300' : 'hover:bg-white/10'
            }`}
          >
            <div className={`relative h-12 w-12 ${p.asleep ? 'opacity-50' : ''}`}>
              <div className="h-12 w-12 overflow-hidden rounded-md bg-brown-700">
                {f && (
                  <div
                    style={{
                      width: 32,
                      height: 32,
                      transform: 'scale(1.5)',
                      transformOrigin: 'top left',
                      backgroundImage: `url(${f.url})`,
                      backgroundPosition: `-${f.x}px -${f.y}px`,
                      imageRendering: 'pixelated',
                    }}
                  />
                )}
              </div>
              {p.status && (
                <span
                  className={`absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-black/75 text-[11px] leading-none shadow ${
                    p.status === '💬' ? 'animate-pulse ring-1 ring-yellow-300' : ''
                  }`}
                >
                  {p.status}
                </span>
              )}
            </div>
            <span className="font-body text-[10px] leading-none text-white">{p.name}</span>
            {typeof p.energy === 'number' && (
              <Bar icon="⚡" label="Energy" value={p.energy} color={barColor(p.energy)} />
            )}
            {typeof p.food === 'number' && (
              <Bar icon="🍔" label="Food" value={p.food} color={barColor(p.food)} />
            )}
            {typeof p.social === 'number' && (
              <Bar icon="🫶" label="Social" value={p.social} color={barColor(p.social)} />
            )}
            <div className="flex items-center gap-1.5">
              {typeof p.money === 'number' && (
                <span className="font-body text-[9px] leading-none text-emerald-300" title="Money">
                  ${Math.round(p.money)}
                </span>
              )}
              {typeof p.prestige === 'number' && (
                <span
                  className="font-body text-[9px] leading-none text-yellow-300"
                  title="Standing in town"
                >
                  ⭐{p.prestige > 0 ? '+' : ''}
                  {Math.round(p.prestige)}
                </span>
              )}
            </div>
          </button>
        );
      })}
    </div>
  );
}
