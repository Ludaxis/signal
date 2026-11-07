// WCAG 2.1 relative luminance and contrast ratio. No dependencies.
// https://www.w3.org/TR/WCAG21/#dfn-relative-luminance

export function parseHex(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) throw new Error(`Expected #RRGGBB colour, got ${hex}`);
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function channel(c) {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

export function luminance(hex) {
  const [r, g, b] = parseHex(hex);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrastRatio(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** Returns one result row per (theme, pair) with the measured ratio and pass flag. */
/** The pair lists a theme is checked against: its own under contrast.byTheme, else the shared ones. */
export function pairsFor(tokens, themeName) {
  return tokens.contrast.byTheme?.[themeName] ?? tokens.contrast;
}

export function checkTokens(tokens) {
  const rows = [];
  const themes = tokens.color.themes;
  const groups = [
    ['text', 4.5],
    ['nonText', 3],
  ];
  for (const [themeName, theme] of Object.entries(themes)) {
    const pairs = pairsFor(tokens, themeName);
    for (const [group, min] of groups) {
      for (const [fg, bg] of pairs[group]) {
        if (!(fg in theme) || !(bg in theme)) {
          rows.push({ theme: themeName, group, fg, bg, ratio: 0, min, pass: false, error: 'missing token' });
          continue;
        }
        const ratio = contrastRatio(theme[fg], theme[bg]);
        rows.push({ theme: themeName, group, fg, bg, ratio, min, pass: ratio >= min });
      }
    }
  }
  return rows;
}
