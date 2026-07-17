import { useRef, useState } from 'react';
import type { ChangeEvent, ClipboardEvent } from 'react';
import { Modal, Field } from './ui';
import { useToast } from './ui-hooks';
import { reportProblem } from '../lib/supabase';
import { getRecentErrors } from '../lib/report-error';
import { compressImageToJpeg, MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES } from '../lib/image-resize';

type Category = 'bug' | 'question' | 'unsure';

const CATEGORY_OPTIONS: { value: Category; label: string }[] = [
  { value: 'bug', label: "The website isn't working correctly" },
  { value: 'question', label: 'I have a question about an event, rule, or policy' },
  { value: 'unsure', label: "I'm not sure" },
];

interface Attachment {
  id: string;
  name: string;
  dataBase64: string;
  previewUrl: string;
}

/** Two-step "Report a problem" dialog, reachable from the nav drawer for any
 *  signed-in user (the edge function requires auth). Step 1 picks a category,
 *  step 2 collects a free-text description plus up to 3 optional screenshots
 *  (file picker or clipboard paste, compressed client-side); submit routes an
 *  email server-side via the `report-problem` edge function, attaching the
 *  current route, build version, the recent-errors ring buffer, and any
 *  screenshots for debugging context. */
export function ReportProblemDialog({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const [step, setStep] = useState<1 | 2>(1);
  const [category, setCategory] = useState<Category | null>(null);
  const [description, setDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [processingFiles, setProcessingFiles] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const canSubmit = category !== null && description.trim().length > 0;

  const addFiles = async (files: File[]) => {
    const imageFiles = files.filter((f) => f.type.startsWith('image/'));
    if (imageFiles.length < files.length) {
      toast('Only image files can be attached.', { variant: 'error' });
    }
    const remaining = MAX_ATTACHMENTS - attachments.length;
    if (remaining <= 0) {
      toast(`You can attach up to ${MAX_ATTACHMENTS} screenshots.`, { variant: 'error' });
      return;
    }
    const toProcess = imageFiles.slice(0, remaining);
    if (imageFiles.length > toProcess.length) {
      toast(`Only ${toProcess.length} more screenshot(s) could be added (max ${MAX_ATTACHMENTS}).`, { variant: 'error' });
    }
    setProcessingFiles(true);
    for (const file of toProcess) {
      try {
        const { dataBase64, sizeBytes } = await compressImageToJpeg(file);
        if (sizeBytes > MAX_ATTACHMENT_BYTES) {
          toast(`${file.name || 'That screenshot'} is too large even after compression (max 2MB).`, { variant: 'error' });
          continue;
        }
        setAttachments((prev) => (prev.length >= MAX_ATTACHMENTS ? prev : [...prev, {
          id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
          name: file.name || 'screenshot.jpg',
          dataBase64,
          previewUrl: `data:image/jpeg;base64,${dataBase64}`,
        }]));
      } catch (e) {
        toast(e instanceof Error ? e.message : `Could not process ${file.name || 'that image'}.`, { variant: 'error' });
      }
    }
    setProcessingFiles(false);
  };

  const handleFileInput = (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = ''; // allow re-selecting the same file later
    if (files.length) void addFiles(files);
  };

  const handlePaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const items = Array.from(e.clipboardData?.items ?? []);
    const imageFiles = items
      .filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
      .map((it) => it.getAsFile())
      .filter((f): f is File => f !== null);
    if (imageFiles.length) void addFiles(imageFiles);
  };

  const removeAttachment = (id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  };

  const submit = async () => {
    if (!canSubmit || submitting) return;
    setSubmitting(true);
    const res = await reportProblem({
      category: category!,
      description: description.trim(),
      route: window.location.hash,
      appVersion: __BUILD_INFO__.sha,
      recentErrors: getRecentErrors(),
      ...(attachments.length
        ? { attachments: attachments.map((a) => ({ name: a.name, type: 'image/jpeg' as const, dataBase64: a.dataBase64 })) }
        : {}),
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
              onPaste={handlePaste}
              placeholder="Describe the problem or your question…"
              autoFocus
            />
          </Field>

          <div style={{ marginTop: 14 }}>
            <p style={{ fontSize: 12, color: 'var(--ink-soft)', margin: '0 0 8px' }}>
              A screenshot helps us fix it faster — attach up to {MAX_ATTACHMENTS} (or paste one into the text box above).
            </p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
              {attachments.map((a) => (
                <div
                  key={a.id}
                  style={{ position: 'relative', width: 64, height: 64, borderRadius: 8, overflow: 'hidden', border: '1px solid var(--line)', flexShrink: 0 }}
                >
                  <img src={a.previewUrl} alt={a.name} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
                  <button
                    type="button"
                    onClick={() => removeAttachment(a.id)}
                    aria-label={`Remove ${a.name}`}
                    style={{
                      position: 'absolute', top: 2, right: 2, width: 18, height: 18, borderRadius: '50%',
                      border: 'none', background: 'var(--navy-800)', color: '#fff', fontSize: 11, lineHeight: '18px',
                      padding: 0, cursor: 'pointer',
                    }}
                  >
                    ✕
                  </button>
                </div>
              ))}
              {attachments.length < MAX_ATTACHMENTS && (
                <button
                  type="button"
                  className="btn ghost small"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={processingFiles}
                >
                  {processingFiles ? 'Processing…' : 'Attach screenshots'}
                </button>
              )}
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                onChange={handleFileInput}
                style={{ display: 'none' }}
              />
            </div>
          </div>

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
