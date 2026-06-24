import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode, RefObject } from 'react';
import { Link } from 'react-router-dom';

export interface MembershipBannerItem {
  type: 'athlete' | 'coach';
  label: string;
  status: string;
}

/**
 * One status badge, Title Case. Renders both a full form (`mb-full`, shown inline)
 * and a short form (`mb-short`, shown when the badges are stacked onto their own
 * second row). CSS toggles between them via the parent's `data-mode`.
 */
function Badge({ item, seasonName, clubShort }: {
  item: MembershipBannerItem;
  seasonName: string;
  clubShort: string;
}) {
  const role = item.label; // 'Athlete' | 'Coach'
  let full: ReactNode;
  let short: string;
  switch (item.status) {
    case 'active':
      full = <>✓ {seasonName} {role} Membership Active</>;
      short = `✓ ${role} Membership Active`;
      break;
    case 'pending-club-payment':
      full = <>⏳ {seasonName} {role} Membership — Pending Payment by {clubShort} <Link to="/membership">· Details</Link></>;
      short = `⏳ ${role} Membership Pending`;
      break;
    case 'pending-waiver':
      full = <>⏳ {seasonName} {role} Membership — Pending Guardian Waiver <Link to="/membership">· Details</Link></>;
      short = `⏳ ${role} Membership Pending`;
      break;
    default:
      full = <>✕ No {seasonName} {role} Membership <Link to="/membership">· Purchase Now</Link></>;
      short = `✕ No ${role} Membership`;
      break;
  }
  const tone = item.status === 'active' ? 'ok' : 'warn';
  return (
    <span className={`member-banner ${tone} is-${item.type}`}>
      <span className="mb-full">{full}</span>
      <span className="mb-short">{short}</span>
    </span>
  );
}

type Mode = 'inline' | 'stacked';

export function TopbarMembership({ items, seasonName, clubShort, topbarRef }: {
  items: MembershipBannerItem[];
  seasonName: string;
  clubShort: string;
  topbarRef: RefObject<HTMLElement | null>;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<Mode>('inline');

  // Decide inline vs stacked by directly observing the real layout rather than
  // estimating widths (margins / sub-pixel rounding make estimates unreliable):
  // render the badges inline, then check whether the line-1 user chip got pushed
  // off the crumb's row. If it did, the row is too tight — drop the badges to their
  // own full-width second row instead (so the name never wraps; the badges bump).
  const measure = useCallback(() => {
    const topbar = topbarRef.current;
    const root = rootRef.current;
    if (!topbar || !root) return;

    root.dataset.mode = 'inline';
    const crumb = topbar.querySelector('.crumb');
    const users = topbar.querySelectorAll('.topbar-user');
    const name = users[users.length - 1];
    // Reading getBoundingClientRect forces the synchronous reflow we need here.
    const wrapped = !!crumb && !!name
      && name.getBoundingClientRect().top - crumb.getBoundingClientRect().top > 6;
    const next: Mode = wrapped ? 'stacked' : 'inline';
    root.dataset.mode = next;
    setMode((prev) => (prev === next ? prev : next));
  }, [topbarRef]);

  useLayoutEffect(() => {
    measure();
    const topbar = topbarRef.current;
    if (!topbar || typeof ResizeObserver === 'undefined') return;
    let raf = 0;
    let lastWidth = topbar.clientWidth;
    const ro = new ResizeObserver((entries) => {
      // Only react to width changes. Switching inline↔stacked changes the topbar's
      // height, which would otherwise re-fire the observer and risk a feedback loop.
      const width = entries[0].contentRect.width;
      if (Math.abs(width - lastWidth) < 0.5) return;
      lastWidth = width;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(measure);
    });
    ro.observe(topbar);
    return () => {
      ro.disconnect();
      cancelAnimationFrame(raf);
    };
    // Re-measure when the badge set / labels change (they affect content width).
  }, [measure, items, seasonName, clubShort, topbarRef]);

  if (items.length === 0) return null;
  return (
    <div ref={rootRef} className="topbar-membership" data-mode={mode}>
      {items.map((it) => (
        <Badge key={it.type} item={it} seasonName={seasonName} clubShort={clubShort} />
      ))}
    </div>
  );
}
