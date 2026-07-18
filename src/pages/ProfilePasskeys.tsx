// Passkey (passwordless sign-in) management section for the self-service
// Profile page. Separate card from the Two-factor authentication card
// (ProfileMfa.tsx) — these are Supabase's free "Passkeys" sign-in feature
// (auth.registerPasskey/auth.passkey.*), NOT an MFA factor. Not shown in
// adminView, same rationale as MfaSection: passkeys belong to the signed-in
// auth session, not to an arbitrary person record an admin is editing.
import { useEffect, useState } from 'react';
import type { PasskeyListItem } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import { passkeyRegisterErrorMessage, defaultPasskeyFriendlyName } from '../lib/passkey-core';
import { Modal } from '../components/ui';
import { useToast } from '../components/ui-hooks';

export function PasskeysSection() {
  const toast = useToast();
  const [passkeys, setPasskeys] = useState<PasskeyListItem[] | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [addBusy, setAddBusy] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<PasskeyListItem | null>(null);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [renameTarget, setRenameTarget] = useState<string | null>(null); // passkey id
  const [renameValue, setRenameValue] = useState('');
  const [renameBusy, setRenameBusy] = useState(false);

  const loadPasskeys = async () => {
    if (!supabase) return;
    const { data, error } = await supabase.auth.passkey.list();
    if (error) { setLoadErr(error.message); return; }
    setLoadErr(null);
    setPasskeys(data ?? []);
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!supabase) return;
      const { data, error } = await supabase.auth.passkey.list();
      if (cancelled) return;
      if (error) { setLoadErr(error.message); return; }
      setLoadErr(null);
      setPasskeys(data ?? []);
    })();
    return () => { cancelled = true; };
  }, []);

  if (!supabase) return null;
  // Narrowed non-null binding for the handlers below — `supabase` (the module
  // import) doesn't stay narrowed inside closures defined after this guard.
  const client = supabase;

  const addPasskey = async () => {
    setAddBusy(true);
    const { data, error } = await client.auth.registerPasskey();
    if (error || !data) {
      setAddBusy(false);
      toast(passkeyRegisterErrorMessage(error), { variant: 'error' });
      await loadPasskeys();
      return;
    }
    // registerPasskey() doesn't take a friendlyName param (server assigns a
    // default) — give it a readable one right away so the list isn't a
    // meaningless id; the user can rename it after. Best-effort: a failure
    // here shouldn't undo the successful registration.
    await client.auth.passkey.update({ passkeyId: data.id, friendlyName: defaultPasskeyFriendlyName() });
    setAddBusy(false);
    toast('Passkey added — you can use it at sign-in.');
    await loadPasskeys();
  };

  const startRename = (pk: PasskeyListItem) => {
    setRenameTarget(pk.id);
    setRenameValue(pk.friendly_name ?? '');
  };

  const saveRename = async () => {
    if (!renameTarget) return;
    const name = renameValue.trim();
    if (!name) { toast('Enter a name.', { variant: 'error' }); return; }
    setRenameBusy(true);
    const { error } = await client.auth.passkey.update({ passkeyId: renameTarget, friendlyName: name });
    setRenameBusy(false);
    if (error) { toast(`Could not rename: ${error.message}`, { variant: 'error' }); return; }
    setRenameTarget(null);
    toast('Passkey renamed.');
    await loadPasskeys();
  };

  const removePasskey = async (pk: PasskeyListItem) => {
    setRemoveBusy(true);
    const { error } = await client.auth.passkey.delete({ passkeyId: pk.id });
    setRemoveBusy(false);
    setRemoveTarget(null);
    if (error) { toast(`Could not remove: ${error.message}`, { variant: 'error' }); return; }
    toast(`Removed "${pk.friendly_name ?? 'passkey'}".`);
    await loadPasskeys();
  };

  return (
    <div className="card card-pad" style={{ marginBottom: 16 }}>
      <h3 className="card-title">Passkeys</h3>
      <p style={{ fontSize: 13.5, color: 'var(--ink-soft)', marginTop: 0 }}>
        Sign in without your password using Face ID, Touch ID, or Windows Hello.
      </p>

      {loadErr && <p style={{ fontSize: 13, color: 'var(--coral-600)' }}>{loadErr}</p>}

      {passkeys && passkeys.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12 }}>
          {passkeys.map((pk) => (
            <div key={pk.id} style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              {renameTarget === pk.id ? (
                <>
                  <input
                    className="input"
                    style={{ maxWidth: 220 }}
                    value={renameValue}
                    autoFocus
                    onChange={(e) => setRenameValue(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') void saveRename(); if (e.key === 'Escape') setRenameTarget(null); }}
                  />
                  <button className="btn primary small" disabled={renameBusy} onClick={saveRename}>Save</button>
                  <button className="btn ghost small" disabled={renameBusy} onClick={() => setRenameTarget(null)}>Cancel</button>
                </>
              ) : (
                <>
                  <span style={{ fontSize: 13, fontWeight: 500 }}>🔑 {pk.friendly_name || 'Passkey'}</span>
                  <span style={{ fontSize: 12, color: 'var(--ink-soft)' }}>
                    Added {new Date(pk.created_at).toLocaleDateString()}
                    {pk.last_used_at ? ` · last used ${new Date(pk.last_used_at).toLocaleDateString()}` : ''}
                  </span>
                  <button className="btn ghost small" onClick={() => startRename(pk)}>Rename</button>
                  <button className="btn ghost small" onClick={() => setRemoveTarget(pk)}>Remove</button>
                </>
              )}
            </div>
          ))}
        </div>
      )}

      <button className="btn primary small" disabled={addBusy} onClick={addPasskey}>
        {addBusy ? 'Waiting for your device…' : passkeys && passkeys.length > 0 ? 'Add another passkey' : 'Add a passkey'}
      </button>

      {removeTarget && (
        <Modal title="Remove this passkey?" onClose={() => setRemoveTarget(null)}>
          <p style={{ marginTop: 0, fontSize: 14 }}>
            Removing <strong>{removeTarget.friendly_name || 'this passkey'}</strong> means you'll no longer be able to
            sign in with it. This does not sign you out of your current session.
          </p>
          <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
            <button
              className="btn primary"
              style={{ background: 'var(--coral-600)', borderColor: 'var(--coral-600)' }}
              disabled={removeBusy}
              onClick={() => removePasskey(removeTarget)}
            >
              Yes, remove
            </button>
            <button className="btn ghost" disabled={removeBusy} onClick={() => setRemoveTarget(null)}>Cancel</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

