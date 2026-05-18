/** Compact relative age like the reference grid: "now", "5m", "3h", "2d", "9w", "4mo". */
export function relativeAge(ms: number): string {
  const d = Date.now() - ms;
  const s = Math.max(0, Math.floor(d / 1000));
  if (s < 60) return 'now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const day = Math.floor(h / 24);
  if (day < 7) return `${day}d`;
  const w = Math.floor(day / 7);
  if (w < 9) return `${w}w`;
  const mo = Math.floor(day / 30);
  if (mo < 12) return `${mo}mo`;
  return `${Math.floor(day / 365)}y`;
}

/** m:ss clip duration. */
export function fmtDuration(msTotal: number): string {
  const s = Math.round(msTotal / 1000);
  return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`;
}
