// Shared CSPRNG token generator for no-login link flows (manager-access review,
// waiver signing). 256 bits of entropy as 64 lowercase hex chars — the token
// columns it feeds (manager_access_requests.token, waiver_sign_requests.token)
// are plain `text not null unique` with no length constraint, so this is a
// drop-in replacement for the prior `crypto.randomUUID().replace(/-/g, '')`
// (122-bit) generation. Existing shorter tokens already stored keep working
// unchanged — only generation changed, never lookup/validation (both compare
// by plain string equality).
export function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
