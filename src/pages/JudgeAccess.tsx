import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { judgeUnlock } from '../lib/supabase';
import { saveJudgeAccess } from '../lib/judge-access-storage';

/** Public (no-login) landing page for a judge-access link/QR:
 *  `/judge/access/:token`. Unlocks the token, stores it locally, and
 *  redirects to `/judge` with the event pre-selected — mirrors WaiverSign's
 *  no-login token-landing shape. */
export default function JudgeAccess() {
  const { token = '' } = useParams();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await judgeUnlock({ token });
      if (cancelled) return;
      if (!res.ok || !res.eventId || !res.token) {
        setError(res.error ?? 'This access link is no longer valid.');
        return;
      }
      saveJudgeAccess(res.eventId, res.token);
      navigate(`/judge?event=${res.eventId}`, { replace: true });
    })();
    return () => { cancelled = true; };
  }, [token, navigate]);

  if (error) {
    return (
      <div className="card card-pad" style={{ maxWidth: 480, margin: '40px auto' }}>
        <h2>This access link is no longer valid.</h2>
        <p style={{ color: 'var(--ink-soft)' }}>{error}</p>
        <p style={{ color: 'var(--ink-soft)', fontSize: 13 }}>
          Ask the event host for a fresh link, code, or QR — or open the Score entry
          page directly and enter the 6-digit code.
        </p>
      </div>
    );
  }

  return (
    <div className="card card-pad" style={{ maxWidth: 480, margin: '40px auto' }}>
      <p>Unlocking judge access…</p>
    </div>
  );
}
