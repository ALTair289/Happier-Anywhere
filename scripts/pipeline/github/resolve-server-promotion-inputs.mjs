// @ts-check

import fs from 'node:fs';
import { parseArgs } from 'node:util';

function fail(message) {
  throw new Error(message);
}

function readBoolean(value, name) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  fail(`${name} must be true or false.`);
}

function validateSourceRef(value) {
  if (/^[0-9a-fA-F]{40}$/.test(value)) return value.toLowerCase();
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/.test(value)) fail('--source-ref contains unsupported characters.');
  if (value.includes('..') || value.includes('//') || value.includes('@{') || value.endsWith('/') || value.endsWith('.') || value.endsWith('.lock')) {
    fail('--source-ref is not a valid safe Git ref form.');
  }
  return value;
}

const { values } = parseArgs({
  options: {
    environment: { type: 'string' },
    'source-ref': { type: 'string' },
    'allow-cross-promote': { type: 'string' },
    bump: { type: 'string' },
    'github-output': { type: 'string' },
  },
  allowPositionals: false,
});

const environment = String(values.environment ?? '');
if (environment !== 'preview' && environment !== 'production') fail('--environment must be preview or production.');
const allowCrossPromote = readBoolean(String(values['allow-cross-promote'] ?? ''), '--allow-cross-promote');
const bump = String(values.bump ?? '');
if (!['none', 'patch', 'minor', 'major'].includes(bump)) fail('--bump must be none, patch, minor, or major.');
const requestedSourceRef = String(values['source-ref'] ?? '');
const sourceRef = validateSourceRef(requestedSourceRef === 'auto' ? (environment === 'preview' ? 'preview' : 'main') : requestedSourceRef);
const defaultSourceRef = environment === 'preview' ? 'preview' : 'main';
if (sourceRef !== defaultSourceRef && !allowCrossPromote) {
  fail(`${environment === 'preview' ? 'Preview' : 'Production'} cross-promotion requires --allow-cross-promote true.`);
}
if (bump !== 'none' && !['dev', 'preview', 'main'].includes(sourceRef)) {
  fail('Version bumps require source_ref dev, preview, or main.');
}

const githubOutput = String(values['github-output'] ?? '');
if (!githubOutput) fail('--github-output is required.');
fs.appendFileSync(githubOutput, `source_ref=${sourceRef}\nenvironment=${environment}\nbump=${bump}\n`, 'utf8');
