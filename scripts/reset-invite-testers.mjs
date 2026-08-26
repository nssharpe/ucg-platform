// Resets the ZZTEST invite-test athletes so lane A-07 can be re-run from scratch.
//
// Accepting an invite permanently CLAIMS a person row (auth_user_id set) and
// creates an auth user, so a second A-07 run needs a clean slate. This script
// deletes the auth users for a HARDCODED allowlist of test addresses and nulls
// the matching people rows' auth_user_id — the person rows, club membership and
// any registrations are left intact.
//
// Deliberately hardcoded (never takes an address argument): a typo'd or
// user-supplied address must never be able to delete a real account. Every
// address here is a jzsharpe+ alias created 2026-08-26 for invite testing.
//
// Usage: node scripts/reset-invite-testers.mjs <staging|prod>
import { readFileSync } from 'node:fs';
import pg from 'pg';

const EMAILS = [
  'jzsharpe+avery@gmail.com',
  'jzsharpe+brooke@gmail.com',
  'jzsharpe+casey@gmail.com',
  'jzsharpe+devon@gmail.com',
  'jzsharpe+emery@gmail.com',
];

const env = Object.fromEntries(
  readFileSync('C:/dev/ucg-platform/.env.local', 'utf8').split(/\r?\n/)
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^"|"$/g, '')]; }),
);
const targets = {
  prod: { ref: 'wkyerxlgricfphopocoz', password: env.PROD_DB_PASSWORD },
  staging: { ref: 'xogpiksqtkayxwmczlbx', password: env.STAGING_DB_PASSWORD },
};
const which = process.argv[2];
const t = targets[which];
if (!t || !t.password) { console.error('usage: node scripts/reset-invite-testers.mjs <staging|prod>'); process.exit(2); }

const client = new pg.Client({
  connectionString: `postgresql://postgres.${t.ref}:${encodeURIComponent(t.password)}@aws-1-us-west-2.pooler.supabase.com:5432/postgres`,
  ssl: { rejectUnauthorized: false },
});
await client.connect();
try {
  const before = await client.query(
    `select p.first_name, p.email, p.auth_user_id is not null as claimed,
            exists (select 1 from auth.users u where u.email = p.email) as has_auth_user
       from people p where p.email = any($1::text[]) order by p.email`, [EMAILS]);
  if (!before.rows.length) { console.log('No matching test people rows found — nothing to reset.'); process.exit(0); }
  console.table(before.rows);

  const unclaimed = await client.query(
    `update people set auth_user_id = null, updated_at = now()
      where email = any($1::text[]) and auth_user_id is not null returning email`, [EMAILS]);
  const deleted = await client.query(
    `delete from auth.users where email = any($1::text[]) returning email`, [EMAILS]);

  console.log(`\nunclaimed ${unclaimed.rowCount} person row(s):`, unclaimed.rows.map((r) => r.email).join(', ') || '(none)');
  console.log(`deleted ${deleted.rowCount} auth user(s):`, deleted.rows.map((r) => r.email).join(', ') || '(none)');
  console.log('\nReady for another A-07 run.');
} finally {
  await client.end();
}
