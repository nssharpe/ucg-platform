import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { Link } from 'react-router-dom';

export interface MembershipBannerItem {
  type: 'athlete' | 'coach';
  label: string;
  status: string;
}

/** One status badge. `mb-season` / `mb-link` spans are the pieces the fitter sheds. */
function Badge({ item, seasonName, clubShort }: {
  item: MembershipBannerItem;
  seasonName: string;
  clubShort: string;
}) {
  const season = <span className="mb-season">{seasonName} </span>;
  const cls = (tone: 'ok' | 'warn') => `member-banner ${tone} is-${item.type}`;
  switch (item.status) {
    case 'active':
      return <span className={cls('ok')}>✓ {season}{item.label} membership active</span>;
    case 'pending-club-payment':
      return (
        <span className={cls('warn')}>
          ⏳ {season}{item.label} membership — pending payment by {clubShort}
          <span className="mb-link"> · <Link to="/membership">details</Link></span>
        </span>
      );
    case 'pending-waiver':
      return (
        <span className={cls('warn')}>
          ⏳ {season}{item.label} membership — pending guardian waiver
          <span className="mb-link"> · <Link to="/membership">details</Link></span>
        </span>
      );
    default:
      return (
        <span className={cls('warn')}>
          ✕ No {season}{item.label} membership
          <span className="mb-link"> · <Link to="/membership">purchase now</Link></span>
        </span>
      );
  }
}

type Mode = 'inline' | 'stacked';
type Shed = 0 | 1 | 2; // 0 full · 1 drop link · 2 drop link + season

export function TopbarMembership({ items, seasonName, clubShort, topbarRef }: {
  items: MembershipBannerItem[];
  seasonName: string;
  clubShort: string;
  topbarRef: RefObject<HTMLElement | null>;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<Mode>('inline');
  const [shed, setShed] = useState<Shed>(0);

  // Measure real widths and pick the tightest state that still fits.
  // Uses forced synchronous layout (reading scrollWidth after each dataset
  // write reflows), which is fine here: it only runs on resize, on one element.
  const measure = useCallback(() => {
    const topbar = topbarRef.current;
    const root = rootRef.current;
    if (!topbar || !root) return;

    // Probe inline fit: force the topbar onto a single line and check overflow.
    root.dataset.mode = 'inline';
    root.dataset.shed = '0';
    const prevWrap = topbar.style.flexWrap;
    topbar.style.flexWrap = 'nowrap';
    const inlineFits = topbar.scrollWidth <= topbar.clientWidth;
    topbar.style.flexWrap = prevWrap;
    if (inlineFits) {
      commit('inline', 0);
      return;
    }

    // Stacked: badges on their own full-width row. Shed pieces until the row fits.
    root.dataset.mode = 'stacked';
    let nextShed: Shed = 0;
    root.dataset.shed = '0';
    if (root.scrollWidth > root.clientWidth) {
      nextShed = 1;
      root.dataset.shed = '1';
      if (root.scrollWidth > root.clientWidth) {
        nextShed = 2;
        root.dataset.shed = '2';
      }
    }
    commit('stacked', nextShed);

    function commit(m: Mode, s: Shed) {
      setMode((prev) => (prev === m ? prev : m));
      setShed((prev) => (prev === s ? prev : s));
    }
  }, [topbarRef]);

  useLayoutEffect(() => {
    measure();
    const topbar = topbarRef.current;
    if (!topbar || typeof ResizeObserver === 'undefined') return;
    let raf = 0;
    const ro = new ResizeObserver(() => {
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
    <div ref={rootRef} className="topbar-membership" data-mode={mode} data-shed={shed}>
      {items.map((it) => (
        <Badge key={it.type} item={it} seasonName={seasonName} clubShort={clubShort} />
      ))}
    </div>
  );
}
