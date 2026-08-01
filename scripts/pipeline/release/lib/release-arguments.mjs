// @ts-check

import { normalizePublicReleaseChannel } from './public-release-rings.mjs';

export function parseArgs(argv) {
  const kv = new Map();
  const flags = new Set();
  const positionals = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }
    if (arg.includes('=')) {
      const idx = arg.indexOf('=');
      kv.set(arg.slice(0, idx), arg.slice(idx + 1));
      continue;
    }
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      kv.set(arg, next);
      i += 1;
      continue;
    }
    flags.add(arg);
  }
  return { kv, flags, positionals };
}

export function normalizeChannel(raw) {
  const value = String(raw ?? '').trim();
  if (!value) return 'stable';
  const normalized = normalizePublicReleaseChannel(value);
  if (!normalized) {
    throw new Error(`[release] invalid channel: ${value} (expected stable|preview|dev)`);
  }
  return normalized;
}
