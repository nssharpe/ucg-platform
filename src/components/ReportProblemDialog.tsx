import { useState } from 'react';
import { Modal, Field } from './ui';
import { useToast } from './ui-hooks';
import { reportProblem } from '../lib/supabase';
import { getRecentErrors } from '../lib/report-error';

type Category = 'bug' | 'question' | 'unsure';

const CATEGORY_OPTIONS: { value: Category; label: string }[] = [
  { value: 'bug', label: "The website isn't working correctly" },
  { value: 'question', label: 'I have a question about an event, rule, or policy' },
  { value: 'unsure', label: "I'm not sure" },
];

/** Two-step "Report a problem" dialog, reachable from the nav drawer for any
 *  signed-in user (the edge function requires auth). Step 1 picks a category,
 *  step 2 collects a free-text description; submit routes an email server-side
 *  via the `report-problem` edge function, attaching the current route, build
 *  version, and the recent-errors ring buffer for debugging context. */
export function ReportProblemDialog({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const [step, setStep] = useState<1 | 2>(1);
  const [category, setCategory] = useState<Category | null>(null);
  const [description, setDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const canSubmit = category !== null && description.trim().length > 0;

  const submit = async () => {
    if (!canSubmit || submitting) return;
    setSubmitting(true);
    const res = await reportProblem({
      category: category!,
      description: description.trim(),
      route: window.location.hash,
      appVersion: __BUILD_INFO__.sha,
      recentErrors: getRecentErrors(),
    });
    setSubmitting(false);
    if (res.ok) {
      toast('Thanks — your report was sent.');
      onClose();
    } else {
      toast(res.error ?? 'Could not send your report.', { variant: 'error', persist: true });
    }
  };

  return (
    <Modal title="Report a problem" onClose={onClose}>
      {step === 1 ? (
        <>
          <p style={{ fontSize: 13, color: 'var(--ink-soft)', margin: '0 0 12px' }}>What kind of problem?</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 18 }}>
            {CATEGORY_OPTIONS.map((o) => (
              <button
                key={o.value}
                type="button"
                className={`btn ${category === o.value ? 'primary' : 'ghost'}`}
                style={{ justifyContent: 'flex-start', textAlign: 'left' }}
                onClick={() => { setCategory(o.value); setStep(2); }}
              >
                {o.label}
              </button>
            ))}
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button className="btn ghost" onClick={onClose}>Cancel</button>
          </div>
        </>
      ) : (
        <>
          <p style={{ fontSize: 13, color: 'var(--ink-soft)', margin: '0 0 12px' }}>
            {CATEGORY_OPTIONS.find((o) => o.value === category)?.label}
          </p>
          <Field label="Tell us what's going on" required>
            <textarea
              className="input"
              rows={5}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Describe the problem or your question…"
              autoFocus
            />
          </Field>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 18 }}>
            <button className="btn ghost" onClick={() => setStep(1)} disabled={submitting}>Back</button>
            <button className="btn primary" onClick={submit} disabled={!canSubmit || submitting}>
              {submitting ? 'Sending…' : 'Submit'}
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
