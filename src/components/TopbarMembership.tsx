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

export function TopbarMembership({ items, seasonName, clubShort }: {
  items: MembershipBannerItem[];
  seasonName: string;
  clubShort: string;
}) {
  if (items.length === 0) return null;
  return (
    <div className="topbar-membership" data-mode="inline" data-shed="0">
      {items.map((it) => (
        <Badge key={it.type} item={it} seasonName={seasonName} clubShort={clubShort} />
      ))}
    </div>
  );
}
