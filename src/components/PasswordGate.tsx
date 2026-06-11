import { useState } from 'react';

// A lightweight password screen in front of the whole app (v1.x — for the hosted build).
//
// The expected password is baked in at build time from VITE_APP_PASSWORD. If that env var is
// unset (e.g. local dev), the gate is bypassed entirely so local work isn't blocked. On a
// correct entry we remember it in localStorage so you stay in across reloads.
//
// Honest scope: this gates the UI, not the data. The Convex backend is public, so this keeps
// casual visitors out of the viewer — it is not real data security.

const EXPECTED = import.meta.env.VITE_APP_PASSWORD as string | undefined;
const STORAGE_KEY = 'terrarium-unlocked';

export default function PasswordGate({ children }: { children: React.ReactNode }) {
  const [unlocked, setUnlocked] = useState(
    () => !EXPECTED || localStorage.getItem(STORAGE_KEY) === '1',
  );
  const [value, setValue] = useState('');
  const [error, setError] = useState(false);

  if (unlocked) return <>{children}</>;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (value === EXPECTED) {
      localStorage.setItem(STORAGE_KEY, '1');
      setUnlocked(true);
    } else {
      setError(true);
      setValue('');
    }
  };

  return (
    <div className="flex min-h-screen w-full items-center justify-center bg-brown-900 p-6 text-brown-100">
      <form
        onSubmit={submit}
        className="w-full max-w-xs rounded-2xl border-4 border-brown-900 bg-brown-800 p-6 shadow-2xl"
      >
        <h1 className="mb-1 text-center font-display text-3xl tracking-wider">Terrarium</h1>
        <p className="mb-4 text-center text-sm text-brown-300">A small society, behind a door.</p>
        <input
          type="password"
          autoFocus
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setError(false);
          }}
          placeholder="Password"
          className="w-full rounded-lg border-2 border-brown-900 bg-brown-700 px-3 py-2 text-center text-brown-100 placeholder-brown-400 focus:outline-none focus:ring-2 focus:ring-yellow-300"
        />
        {error && <p className="mt-2 text-center text-sm text-red-300">Not quite. Try again.</p>}
        <button
          type="submit"
          className="mt-4 w-full rounded-lg border-2 border-brown-900 bg-clay-700 py-2 font-body text-white shadow-solid hover:brightness-110"
        >
          Enter
        </button>
      </form>
    </div>
  );
}
