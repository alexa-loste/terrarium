import { characters } from '../../data/characters.ts';
import { GameId } from '../../convex/aiTown/ids.ts';

export type RosterEntry = {
  id: GameId<'players'>;
  name: string;
  character: string;
  // Live status emoji: 💬 speaking, 💭 thinking, or the current activity emoji.
  status?: string;
};

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
            <div className="relative h-12 w-12">
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
          </button>
        );
      })}
    </div>
  );
}
