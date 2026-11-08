// Seeded randomness for the animation system (blink times, breath phase, crowd offsets). mulberry32 seeded from the
// run seed, the character id and a salt, so every character draws its own stream and the same inputs give the same
// numbers on every machine. Pure module: no imports.

/** FNV-1a over a string (32-bit). */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The stream for one character and purpose. */
export const streamFor = (seed: number, charId: string, salt: string) => mulberry32(hashString(`${seed >>> 0}:${charId}:${salt}`));

/** An integer in [lo, hi] (inclusive). */
export const intIn = (rnd: () => number, lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
