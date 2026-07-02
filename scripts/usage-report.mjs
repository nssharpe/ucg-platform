#!/usr/bin/env node
// Reports Claude Code token usage for this project by parsing the local
// session transcripts (~/.claude/projects/<project-slug>/*.jsonl).
//
// Usage:
//   node scripts/usage-report.mjs            # all sessions, newest first
//   node scripts/usage-report.mjs --days 7   # only sessions active in the last N days
//   node scripts/usage-report.mjs --json     # machine-readable output
//
// Reads token counts only (no message content is printed). Limits/quota
// remaining are NOT knowable from local data — check /usage in the app.

import { readdirSync, statSync, createReadStream } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const daysIdx = args.indexOf('--days');
const days = daysIdx >= 0 ? Number(args[daysIdx + 1]) : Infinity;

// Claude Code slugs the project path by replacing separators/colons with '-'.
const projectSlug = process.cwd().replace(/[\\/:]/g, '-');
const transcriptDir = join(homedir(), '.claude', 'projects', projectSlug);

let files;
try {
  files = readdirSync(transcriptDir).filter((f) => f.endsWith('.jsonl'));
} catch {
  console.error(`No transcript directory found at ${transcriptDir}`);
  console.error('Run this from the project root the sessions were started in.');
  process.exit(1);
}

const cutoff = Number.isFinite(days) ? Date.now() - days * 86400_000 : 0;

function newTotals() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0 };
}

async function parseSession(file) {
  const path = join(transcriptDir, file);
  const mtime = statSync(path).mtime;
  if (mtime.getTime() < cutoff) return null;
  const byModel = new Map();
  let firstTs = null;
  let lastTs = null;
  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.includes('"usage"')) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const msg = entry.message;
    const usage = msg?.usage;
    if (!usage) continue;
    if (entry.timestamp) {
      firstTs ??= entry.timestamp;
      lastTs = entry.timestamp;
    }
    const model = msg.model ?? 'unknown';
    const t = byModel.get(model) ?? newTotals();
    t.input += usage.input_tokens ?? 0;
    t.output += usage.output_tokens ?? 0;
    t.cacheRead += usage.cache_read_input_tokens ?? 0;
    t.cacheWrite += usage.cache_creation_input_tokens ?? 0;
    t.calls += 1;
    byModel.set(model, t);
  }
  if (byModel.size === 0) return null;
  return { session: file.replace('.jsonl', ''), mtime, firstTs, lastTs, byModel };
}

const sessions = (await Promise.all(files.map(parseSession)))
  .filter(Boolean)
  .sort((a, b) => b.mtime - a.mtime);

const fmt = (n) =>
  n >= 1_000_000 ? (n / 1_000_000).toFixed(1) + 'M' : n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);

if (asJson) {
  console.log(
    JSON.stringify(
      sessions.map((s) => ({
        session: s.session,
        lastActive: s.mtime.toISOString(),
        models: Object.fromEntries(s.byModel),
      })),
      null,
      2,
    ),
  );
  process.exit(0);
}

const grand = new Map();
console.log(`Token usage for ${projectSlug}  (${sessions.length} session${sessions.length === 1 ? '' : 's'})\n`);
for (const s of sessions) {
  const date = s.mtime.toISOString().slice(0, 16).replace('T', ' ');
  console.log(`${date}  ${s.session.slice(0, 8)}`);
  for (const [model, t] of s.byModel) {
    console.log(
      `    ${model.padEnd(28)} in ${fmt(t.input).padStart(7)}  out ${fmt(t.output).padStart(7)}  cacheR ${fmt(t.cacheRead).padStart(7)}  cacheW ${fmt(t.cacheWrite).padStart(7)}  (${t.calls} calls)`,
    );
    const g = grand.get(model) ?? newTotals();
    g.input += t.input;
    g.output += t.output;
    g.cacheRead += t.cacheRead;
    g.cacheWrite += t.cacheWrite;
    g.calls += t.calls;
    grand.set(model, g);
  }
}
console.log('\nTotals by model:');
for (const [model, t] of grand) {
  console.log(
    `    ${model.padEnd(28)} in ${fmt(t.input).padStart(7)}  out ${fmt(t.output).padStart(7)}  cacheR ${fmt(t.cacheRead).padStart(7)}  cacheW ${fmt(t.cacheWrite).padStart(7)}  (${t.calls} calls)`,
  );
}
console.log(
  '\nNote: output tokens weigh most against plan limits; cache reads weigh least.' +
    '\nRemaining quota is not exposed locally — check /usage in the Claude Code app.',
);
