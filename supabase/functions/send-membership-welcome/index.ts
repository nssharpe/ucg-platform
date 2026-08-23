// send-membership-welcome — "Welcome to UCG" email for a no-club (Independent)
// member's FIRST membership-only purchase, CC'ing their region's regional team.
//
// Called best-effort by a signed-in member right after a direct membership
// purchase completes (NOT a club-cart push). The CLIENT decides whether this is
// the member's first membership (it has the pre-purchase membership list); this
// function re-validates the server-checkable skip conditions so it can't be
// misused: the target must be a no-club account (main_club_id IS NULL) and must
// NOT be Outside US. If either fails, it sends nothing.
//
// The body names the member's regional leaders — people holding the
// 'regional_rep' app role whose regional_rep_regions.region matches the member's
// region (derived from STATE_REGIONS[state]). The "To" is the member; the only
// "CC" is the region's team address (reps' personal emails are NOT cc'd).
//
// Auth: any signed-in user. Recipient/region/reps are resolved server-side with
// the service role.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { sendOne } from '../_shared/resend.ts';
import { renderEmail } from '../_shared/email-layout.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// State → region. Mirrors STATE_REGIONS in src/lib/types.ts (keep in sync).
const STATE_REGIONS: Record<string, string> = {
  Alabama: 'Southeast', Alaska: 'West', Arizona: 'West', Arkansas: 'South Central',
  California: 'West', Colorado: 'West', Connecticut: 'Northeast', Delaware: 'Mid-Atlantic',
  'District of Columbia': 'Mid-Atlantic', Florida: 'Southeast', Georgia: 'Southeast',
  Hawaii: 'West', Idaho: 'West', Illinois: 'Midwest', Indiana: 'Mideast', Iowa: 'Midwest',
  Kansas: 'South Central', Kentucky: 'Mideast', Louisiana: 'Southeast', Maine: 'Northeast',
  Maryland: 'Mid-Atlantic', Massachusetts: 'Northeast', Michigan: 'Mideast',
  Minnesota: 'Midwest', Mississippi: 'Southeast', Missouri: 'Midwest', Montana: 'West',
  Nebraska: 'Midwest', Nevada: 'West', 'New Hampshire': 'Northeast', 'New Jersey': 'Mid-Atlantic',
  'New Mexico': 'West', 'New York': 'Northeast', 'North Carolina': 'Southeast',
  'North Dakota': 'Midwest', Ohio: 'Mideast', Oklahoma: 'South Central', Oregon: 'West',
  Pennsylvania: 'Mid-Atlantic', 'Rhode Island': 'Northeast', 'South Carolina': 'Southeast',
  'South Dakota': 'Midwest', Tennessee: 'Southeast', Texas: 'South Central', Utah: 'West',
  Vermont: 'Northeast', Virginia: 'Mid-Atlantic', Washington: 'West',
  'West Virginia': 'Mid-Atlantic', Wisconsin: 'Midwest', Wyoming: 'West',
};

// Region → regional-team CC address (all route to Julia for testing).
const REGION_TEAM_EMAIL: Record<string, string> = {
  'South Central': 'julia.sharpe+south-central-regions-team@naigc.org',
  West: 'julia.sharpe+west-coast-regions-team@naigc.org',
  'Mid-Atlantic': 'julia.sharpe+mid-atlantic-regions-team@naigc.org',
  Southeast: 'julia.sharpe+southeast-regions-team@naigc.org',
  Mideast: 'julia.sharpe+mideast-regions-team@naigc.org',
  Northeast: 'julia.sharpe+northeast-regions-team@naigc.org',
  Midwest: 'julia.sharpe+midwest-regions-team@naigc.org',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405);

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

  // --- Validate payload (personId optional; default to caller's own person) ---
  let body: { personId?: string };
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  // --- Authenticate (any signed-in user or service role) ---
  const authHeader = req.headers.get('Authorization') ?? '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (!token) return json({ ok: false, error: 'Missing Authorization header.' }, 401);

  const db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
  const isServiceRole = token === serviceKey;
  let person;

  if (isServiceRole) {
    const personId = (body.personId ?? '').trim();
    if (!personId) {
      return json({ ok: false, error: 'personId is required for service role call.' }, 400);
    }
    const { data: p, error: pErr } = await db
      .from('people')
      .select('id, first_name, email, state, outside_us, main_club_id')
      .eq('id', personId)
      .maybeSingle();
    if (pErr || !p) return json({ ok: false, error: 'Person not found.' }, 404);
    person = p;
  } else {
    const { data: userData, error: userErr } = await db.auth.getUser(token);
    if (userErr || !userData.user) return json({ ok: false, error: 'Invalid or expired session.' }, 401);

    const { data: caller } = await db
      .from('people')
      .select('id, first_name, email, state, outside_us, main_club_id')
      .eq('auth_user_id', userData.user.id)
      .maybeSingle();
    if (!caller) return json({ ok: false, error: 'No linked person for caller.' }, 403);

    const personId = (body.personId ?? '').trim();
    if (personId && personId !== caller.id) {
      return json({ ok: false, error: 'Can only send a welcome for your own account.' }, 403);
    }
    person = caller;
  }

  // --- Server-side skip re-checks (can't be misused) ---
  // Must be a no-club (Independent) account.
  if (person.main_club_id) {
    return json({ ok: true, sent: false, note: 'Account belongs to a club; no welcome sent.' });
  }
  // Skip entirely if Outside US.
  if (person.outside_us === true) {
    return json({ ok: true, sent: false, note: 'Member is Outside US; no welcome sent.' });
  }

  const toEmail = (person.email ?? '').trim();
  if (!EMAIL_RE.test(toEmail)) {
    return json({ ok: true, sent: false, note: 'Member has no valid email.' });
  }

  // --- Resolve the region and its team CC address ---
  const region = STATE_REGIONS[(person.state ?? '').trim()];
  const teamEmail = region ? REGION_TEAM_EMAIL[region] : undefined;
  if (!region || !teamEmail) {
    // No mapped region (e.g. blank/unknown state) — nothing to CC, skip cleanly.
    return json({ ok: true, sent: false, note: 'No mapped region for member; no welcome sent.' });
  }

  // --- Resolve the region's regional leaders (names only) ---
  // regional_rep users for this region → their auth_user_ids → people first/last.
  let repNames: string[] = [];
  const { data: repRegionRows } = await db
    .from('regional_rep_regions')
    .select('user_id')
    .eq('region', region);
  const repUserIds = (repRegionRows ?? []).map((r: { user_id: string }) => r.user_id);
  if (repUserIds.length > 0) {
    // Confirm each still holds the 'regional_rep' app role.
    const { data: roleRows } = await db
      .from('user_roles')
      .select('user_id')
      .eq('role', 'regional_rep')
      .in('user_id', repUserIds);
    const activeRepIds = new Set((roleRows ?? []).map((r: { user_id: string }) => r.user_id));
    const confirmed = repUserIds.filter((id) => activeRepIds.has(id));
    if (confirmed.length > 0) {
      const { data: repPeople } = await db
        .from('people')
        .select('first_name, last_name')
        .in('auth_user_id', confirmed);
      repNames = (repPeople ?? [])
        .map((p: { first_name?: string; last_name?: string }) =>
          `${p.first_name ?? ''} ${p.last_name ?? ''}`.trim())
        .filter((n) => n.length > 0);
    }
  }

  // --- Compose the email ---
  const firstName = (person.first_name ?? '').trim() || 'there';
  const leaderWord = repNames.length > 1 ? 'Regional Leaders' : 'Regional Leader';
  // When reps exist, name them inline: "your <Region> Regional Leader(s), A and B,".
  // When none exist, drop the name list entirely (never render an empty list).
  const namesPart = repNames.length > 0 ? `, ${esc(repNames.join(', '))},` : '';
  const copiedSentence =
    `We know it can be hard to find competition opportunities as an Independent athlete, ` +
    `so we've copied your ${esc(region)} ${leaderWord}${namesPart} ` +
    `who can help you connect with nearby UCG clubs and add you to the regional contact list. ` +
    `Local events are hosted by various clubs and usually announced through regional communication channels.`;

  const link = (href: string, text: string) =>
    `<a href="${href}" style="color:#184B56;text-decoration:underline;">${text}</a>`;

  const subject = 'Welcome to United Club Gymnastics';
  const html = renderEmail({
    heading: 'Welcome to United Club Gymnastics',
    bodyHtml: `<p>Hi ${esc(firstName)},</p>
<p>Welcome to United Club Gymnastics (UCG)! ${copiedSentence}</p>
<p>Upcoming events will also be posted ${link('https://www.unitedgymnastics.org', 'here')} as they are scheduled. Season usually starts around November, with the majority of competitions in January&ndash;March. Regionals are hosted around late February to early March, and then UCG Nationals are held in early to mid-April.</p>
<p>Please visit ${link('https://www.unitedgymnastics.org', 'unitedgymnastics.org')} and follow our social media to stay up-to-date on important UCG information — a good way to learn more and connect with UCG members.</p>
<p>For the Love of the Sport,<br>UCG Volunteer Team</p>`,
  });

  // To = member; CC = region team address only. Resend takes cc as an array.
  try {
    await sendOne({ to: toEmail, cc: [teamEmail], subject, html });
  } catch (e) {
    return json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500);
  }
  return json({ ok: true, sent: true, region, cc: teamEmail, repCount: repNames.length });
});
