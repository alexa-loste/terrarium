import { useState } from 'react';
import { useMutation, useQuery } from 'convex/react';
import { api } from '../../convex/_generated/api';

type Voice = 'post' | 'research' | 'news';

const VOICES: { id: Voice; label: string; author: string }[] = [
  { id: 'post', label: '🗣️ You', author: 'You' },
  { id: 'research', label: '🔬 Research', author: 'You' },
  { id: 'news', label: '📰 The News', author: 'The News' },
];

const KIND_BADGE: Record<Voice, { label: string; cls: string }> = {
  post: { label: 'post', cls: 'bg-slate-600' },
  research: { label: 'research', cls: 'bg-purple-700' },
  news: { label: 'news', cls: 'bg-red-700' },
};

export default function FeedPanel() {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [voice, setVoice] = useState<Voice>('post');

  const worldStatus = useQuery(api.world.defaultWorldStatus);
  const worldId = worldStatus?.worldId;
  const posts = useQuery(api.feed.listFeed, worldId ? { worldId } : 'skip');
  const postToFeed = useMutation(api.feed.postToFeed);

  const submit = async () => {
    if (!worldId || !text.trim()) return;
    const v = VOICES.find((x) => x.id === voice)!;
    await postToFeed({ worldId, authorName: v.author, kind: voice, text });
    setText('');
  };

  return (
    <>
      <button
        onClick={() => setOpen((o) => !o)}
        title="The Feed"
        className="pointer-events-auto absolute right-3 top-3 z-40 flex items-center gap-2 rounded-full border-2 border-brown-900 bg-clay-700 px-3 py-1.5 text-sm text-white shadow-solid"
      >
        📰 Feed
        {posts && posts.length > 0 && (
          <span className="rounded-full bg-black/40 px-1.5 text-xs">{posts.length}</span>
        )}
      </button>

      {open && (
        <div className="pointer-events-auto absolute bottom-3 right-3 top-16 z-40 flex w-[360px] max-w-[90vw] flex-col overflow-hidden rounded-xl border-4 border-brown-900 bg-brown-800 text-brown-100 shadow-2xl">
          <div className="flex items-center justify-between border-b-2 border-brown-900 px-4 py-2">
            <span className="font-display text-xl">The Feed</span>
            <button onClick={() => setOpen(false)} className="text-brown-200 hover:text-white">
              ✕
            </button>
          </div>

          <div className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
            {!posts && <div className="text-sm text-brown-300">Loading…</div>}
            {posts && posts.length === 0 && (
              <div className="text-sm text-brown-300">
                Nothing posted yet. Break some news below — everyone in town will eventually see it.
              </div>
            )}
            {posts?.map((p) => {
              const badge = KIND_BADGE[p.kind as Voice] ?? KIND_BADGE.post;
              return (
                <div key={p._id} className="rounded-lg bg-brown-900/40 p-3">
                  <div className="mb-1 flex items-center gap-2">
                    <span className="font-bold">{p.authorName}</span>
                    <span className={`rounded px-1.5 py-0.5 text-[10px] uppercase ${badge.cls}`}>
                      {badge.label}
                    </span>
                    <span className="ml-auto text-[10px] text-brown-300">
                      {new Date(p.createdAt).toLocaleTimeString([], {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </span>
                  </div>
                  <div className="whitespace-pre-wrap text-sm leading-snug">{p.text}</div>
                </div>
              );
            })}
          </div>

          <div className="border-t-2 border-brown-900 p-3">
            <div className="mb-2 flex gap-1">
              {VOICES.map((v) => (
                <button
                  key={v.id}
                  onClick={() => setVoice(v.id)}
                  className={`flex-1 rounded px-2 py-1 text-xs ${
                    voice === v.id ? 'bg-clay-700 text-white' : 'bg-brown-900/50 text-brown-200'
                  }`}
                >
                  {v.label}
                </button>
              ))}
            </div>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit();
              }}
              placeholder="Publish to the town feed…  (⌘/Ctrl+Enter)"
              rows={2}
              className="w-full resize-none rounded bg-brown-900/60 p-2 text-sm text-white placeholder:text-brown-400 focus:outline-none"
            />
            <button
              onClick={() => void submit()}
              disabled={!text.trim() || !worldId}
              className="mt-2 w-full rounded bg-clay-700 py-1.5 text-sm text-white disabled:opacity-40"
            >
              Post
            </button>
          </div>
        </div>
      )}
    </>
  );
}
