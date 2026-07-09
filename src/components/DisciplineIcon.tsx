import mag1 from '../assets/brand/event-icons/mag1.svg';
import wag1 from '../assets/brand/event-icons/wag1.svg';
import tnt from '../assets/brand/event-icons/tnt.svg';
import type { Discipline } from '../lib/types';

// Official brand discipline icons (single-fill navy #1E2B38 gymnast silhouettes).
// Each discipline ships two alternates (e.g. mag1/mag2) — we standardize on one
// per discipline for visual consistency; mag1/wag1 share a similar landscape
// aspect ratio which pairs cleanly in a row next to WAG.
const ICONS: Record<Discipline, string> = {
  MAG: mag1,
  WAG: wag1,
  TNT: tnt,
};

/** Small decorative discipline icon (navy silhouette) for use next to discipline
 *  labels on light surfaces. Purely decorative — the text label is the
 *  accessible name, so this is `aria-hidden`. Height-constrained; width follows
 *  the icon's native aspect ratio via `object-fit: contain`. */
export function DisciplineIcon({
  discipline,
  size = 16,
  style,
  className,
}: {
  discipline: Discipline;
  size?: number;
  style?: React.CSSProperties;
  className?: string;
}) {
  return (
    <img
      src={ICONS[discipline]}
      alt=""
      aria-hidden="true"
      className={className}
      style={{ height: size, width: 'auto', display: 'inline-block', objectFit: 'contain', verticalAlign: 'middle', ...style }}
    />
  );
}
