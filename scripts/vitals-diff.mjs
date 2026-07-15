#!/usr/bin/env node
// Terrarium v2.10 — VITALS DIFF (the perturbation-probe readout).
//
// Compare two society-vitals snapshots (see convex/vitals.ts) and print every numeric field that
// MOVED. This is the second half of the evolution instrument: take a snapshot, run the world (or
// fork + flip one early accident), snapshot again, and diff. Big deltas on the divergence indices
// = the society is moving / fanning out; near-zero everywhere = homeostatic.
//
// Usage:
//   node scripts/vitals-diff.mjs docs/vitals/baseline-day65.json docs/vitals/day70.json
//   # capture a fresh one first:
//   NODE_EXTRA_CA_CERTS=~/.terrarium-ca.pem npx convex run vitals:snapshot > docs/vitals/dayNN.json
//
// Pure stdlib; no deps. Walks both objects in parallel; only numeric leaves are diffed (strings,
// nulls, and array-of-objects like the per-faction list are skipped — those are texture, the
// scalars are the signal).

import { readFileSync } from 'node:fs';

const [a, b] = process.argv.slice(2);
if (!a || !b) {
  console.error('usage: node scripts/vitals-diff.mjs <snapshotA.json> <snapshotB.json>');
  process.exit(1);
}

const load = (p) => JSON.parse(readFileSync(p, 'utf8'));
const A = load(a);
const B = load(b);

// The fields we want surfaced FIRST — the divergence dimensions. Everything else follows.
const HEADLINE = new Set([
  'wealthGini',
  'reputationGini',
  'polarizationScore',
  'meanIdeaDrift',
  'beliefsDriftedFromSeed',
]);

const rows = []; // { path, from, to, delta, headline }

function walk(x, y, path) {
  if (typeof x === 'number' && typeof y === 'number') {
    if (x !== y) {
      const key = path[path.length - 1];
      rows.push({ path: path.join('.'), from: x, to: y, delta: y - x, headline: HEADLINE.has(key) });
    }
    return;
  }
  if (x && y && typeof x === 'object' && typeof y === 'object' && !Array.isArray(x)) {
    for (const k of Object.keys(x)) {
      if (k in y) walk(x[k], y[k], [...path, k]);
    }
  }
  // arrays + mismatched types: skipped (texture, not scalar signal).
}

walk(A, B, []);

const fmt = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(3));
const arrow = (d) => (d > 0 ? '▲' : '▼');

console.log(`\nVITALS DIFF`);
console.log(`  A: ${a}  (day ${A.day ?? '?'})`);
console.log(`  B: ${b}  (day ${B.day ?? '?'})`);
console.log(`  ${rows.length} numeric field(s) moved\n`);

const headline = rows.filter((r) => r.headline);
const rest = rows.filter((r) => !r.headline);

const printRow = (r) => {
  const d = `${arrow(r.delta)} ${fmt(Math.abs(r.delta))}`;
  console.log(`  ${r.path.padEnd(42)} ${fmt(r.from).padStart(10)} → ${fmt(r.to).padStart(10)}   ${d}`);
};

if (headline.length) {
  console.log('  ── divergence indices ──');
  headline.forEach(printRow);
  console.log('');
}
if (rest.length) {
  console.log('  ── other movement ──');
  rest.forEach(printRow);
}
if (!rows.length) console.log('  (identical — society did not move on any scalar)');
console.log('');
