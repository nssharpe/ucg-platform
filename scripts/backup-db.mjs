#!/usr/bin/env node
// Periodic Supabase data backup (no Docker/pg_dump needed — plain `pg` driver).
//
// Dumps every row of every table in the public, auth, and storage schemas to a
// gzipped JSON file per environment, into a Dropbox-synced folder (offsite via
// Dropbox). Schema is NOT dumped — it's fully recreatable from
// supabase/migrations/. Storage bucket FILE BYTES are not included (only
// storage.objects metadata); bucket contents live in S3 and would need the
// dashboard or Storage API to restore.
//
// Usage:  node scripts/backup-db.mjs [--env prod|staging] [--dest <dir>]
// Creds:  .env.local — STAGING_DB_PASSWORD (staging), PROD_DB_PASSWORD (prod).
//         A missing password skips that environment with a warning (exit 0
//         unless BOTH are missing or a dump fails).
// Prune:  keeps the newest KEEP dumps per environment, deletes older ones.
//
// Scheduled daily via Windows Task Scheduler ("UCG DB Backup", 03:00) — see
// supabase/README.md "Data backups".

import { readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { Client } = require('pg')

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
// Supabase's root CA (public: https://supabase.com/downloads/prod-ca-2021.crt).
// If the file exists TLS is fully verified; otherwise we fall back to
// encrypted-but-unverified (MITM-exposed) with a loud warning.
const CA_PATH = join(ROOT, 'scripts', 'supabase-prod-ca-2021.crt')
const DEFAULT_DEST = 'C:/Users/nssha/Steinsharpe Dropbox/Nate Sharpe/ucg-db-backups'
const KEEP = 14
const SCHEMAS = ['public', 'auth', 'storage']

const args = process.argv.slice(2)
const argVal = (flag) => {
  const i = args.indexOf(flag)
  return i >= 0 ? args[i + 1] : undefined
}
const onlyEnv = argVal('--env')
const dest = argVal('--dest') ?? DEFAULT_DEST

const envFile = Object.fromEntries(
  readFileSync(join(ROOT, '.env.local'), 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()])
)

const TARGETS = {
  prod: { ref: 'wkyerxlgricfphopocoz', password: envFile.PROD_DB_PASSWORD },
  staging: { ref: 'xogpiksqtkayxwmczlbx', password: envFile.STAGING_DB_PASSWORD },
}

let sslConfig
try {
  sslConfig = { ca: readFileSync(CA_PATH, 'utf8'), rejectUnauthorized: true }
} catch {
  console.warn(
    `WARNING: ${CA_PATH} not found — TLS is encrypted but UNVERIFIED (MITM-exposed).\n` +
      'Download https://supabase.com/downloads/prod-ca-2021.crt to that path to fix.'
  )
  sslConfig = { rejectUnauthorized: false }
}

async function dumpEnv(name, { ref, password }) {
  const client = new Client({
    connectionString: `postgresql://postgres:${encodeURIComponent(password)}@db.${ref}.supabase.co:5432/postgres`,
    ssl: sslConfig,
    statement_timeout: 120_000,
  })
  await client.connect()
  try {
    const { rows: tables } = await client.query(
      `select table_schema, table_name from information_schema.tables
       where table_schema = any($1) and table_type = 'BASE TABLE'
       order by table_schema, table_name`,
      [SCHEMAS]
    )
    const dump = { env: name, ref, dumpedAt: new Date().toISOString(), tables: {}, errors: {} }
    for (const { table_schema, table_name } of tables) {
      const fq = `${table_schema}.${table_name}`
      try {
        const { rows } = await client.query(`select * from "${table_schema}"."${table_name}"`)
        dump.tables[fq] = rows
      } catch (e) {
        // Some auth/storage internals aren't readable by the postgres role — record and move on.
        dump.errors[fq] = String(e.message ?? e)
      }
    }
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-')
    const outPath = join(dest, `ucg-${name}-${stamp}.json.gz`)
    writeFileSync(outPath, gzipSync(JSON.stringify(dump)))
    const rowCount = Object.values(dump.tables).reduce((n, r) => n + r.length, 0)
    console.log(
      `[${name}] ${Object.keys(dump.tables).length} tables, ${rowCount} rows -> ${outPath}` +
        (Object.keys(dump.errors).length ? ` (skipped unreadable: ${Object.keys(dump.errors).join(', ')})` : '')
    )
  } finally {
    await client.end()
  }
}

function prune(name) {
  const files = readdirSync(dest)
    .filter((f) => f.startsWith(`ucg-${name}-`) && f.endsWith('.json.gz'))
    .sort()
  for (const f of files.slice(0, Math.max(0, files.length - KEEP))) {
    unlinkSync(join(dest, f))
    console.log(`[${name}] pruned ${f}`)
  }
}

mkdirSync(dest, { recursive: true })
let ran = 0
let failed = false
for (const [name, target] of Object.entries(TARGETS)) {
  if (onlyEnv && name !== onlyEnv) continue
  if (!target.password) {
    console.warn(`[${name}] no ${name === 'prod' ? 'PROD' : 'STAGING'}_DB_PASSWORD in .env.local — skipped`)
    continue
  }
  try {
    await dumpEnv(name, target)
    prune(name)
    ran++
  } catch (e) {
    failed = true
    console.error(`[${name}] FAILED: ${e.message ?? e}`)
  }
}
if (failed || ran === 0) process.exit(1)
