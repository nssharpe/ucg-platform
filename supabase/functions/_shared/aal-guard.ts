// _shared/aal-guard.ts — the Phase-B AAL guard for privileged Edge Functions
// (research doc 2026-06-22, "gate destructive Edge Functions on aal2").
//
// Rule (role-agnostic, mirrors the hardened is_admin() migration
// 20260717140238): a caller with ANY verified MFA factor must present an
// aal2 JWT; an unenrolled caller is untouched. This is safe to apply to
// every caller a function admits — admin, sanctioning, refund_manager,
// host-club manager, event-admin grantee, plain member — because it only
// ever constrains callers who opted into MFA.
//
// Why it exists: these functions authorize via the service-role client, so
// they BYPASS the RLS-level is_admin() hardening — without this guard a
// stolen aal1 JWT for an MFA-enrolled privileged user still exercises the
// function's full power (found in controller review of admin-reset-mfa;
// swept across all admin/role-gated functions 2026-07-17).
//
// Fail-closed: factor-list failure → 500 deny; unreadable aal claim with a
// verified factor present → 403 deny.
import { jwtAalClaim, callerAalSatisfies } from './jwt-aal.ts';

/** Structural slice of the service-role client — avoids coupling to the
 *  supabase-js import URL each function happens to use. */
interface AdminMfaClient {
  auth: {
    admin: {
      mfa: {
        listFactors(params: { userId: string }): Promise<{
          data: { factors: { status: string }[] } | null;
          error: { message: string } | null;
        }>;
      };
    };
  };
}

/**
 * Call RIGHT AFTER the function's existing caller-authentication + role gate.
 *
 * @param adminClient service-role client (already constructed by the caller)
 * @param userId      the authenticated caller's auth uid (from getUser)
 * @param token       the SAME token string getUser() just authenticated
 * @param corsHeaders the function's CORS headers for the error response
 * @returns a ready-to-return 403/500 Response when the caller must be
 *          rejected, or null when the caller passes and the function should
 *          proceed.
 */
export async function requireAalForEnrolledCaller(
  adminClient: AdminMfaClient,
  userId: string,
  token: string,
  corsHeaders: Record<string, string>,
): Promise<Response | null> {
  const deny = (body: unknown, status: number) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  const { data, error } = await adminClient.auth.admin.mfa.listFactors({ userId });
  if (error) return deny({ ok: false, error: 'Could not verify your session security level.' }, 500);
  const hasVerifiedFactor = (data?.factors ?? []).some((f) => f.status === 'verified');
  if (!callerAalSatisfies(jwtAalClaim(token), hasVerifiedFactor)) {
    return deny({
      ok: false,
      error: 'This action requires a two-factor-verified session — sign in again and complete your 2FA challenge.',
    }, 403);
  }
  return null;
}
