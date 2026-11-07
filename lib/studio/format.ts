// One number format for counts across the Studio: "—" when unknown, "9,500" below ten thousand, "12.3k" from
// ten thousand up. Results and the Proven screen both read it, so the same template shows the same number on both.
export function compactCount(v: number | null | undefined): string {
  if (v == null) return '—';
  return v >= 10_000 ? `${(v / 1000).toFixed(1)}k` : v.toLocaleString('en-GB');
}
