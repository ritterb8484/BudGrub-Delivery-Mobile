/**
 * Fuzzy name match between the name on the ID and the ordering customer (BUD-101).
 *
 *  - "match"    → same first and last name after normalisation (case, accents, punctuation, middle names ignored).
 *  - "close"    → minor variance (one or two typos, a nickname-length prefix, hyphenated/compound surname part):
 *                 the agent must confirm manually that it is the same person.
 *  - "mismatch" → different person; hand-over is blocked.
 *
 * The server repeats its own name check on `id-check`; this is for immediate feedback at the door.
 */
export type NameMatch = "match" | "close" | "mismatch";

export function normaliseName(s: string): string[] {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z\s-]/g, " ")
    .split(/[\s-]+/)
    .filter((t) => t.length > 0);
}

/** Edit distance counting an adjacent transposition ("Peirce"/"Pierce") as one edit (optimal string alignment). */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

function tokenCloseness(a: string, b: string): "same" | "close" | "different" {
  if (a === b) return "same";
  const d = editDistance(a, b);
  const allowed = Math.max(a.length, b.length) >= 7 ? 2 : 1;
  if (d <= allowed) return "close";
  // Short form / nickname prefix of at least 3 letters ("Jon" vs "Jonathan", "Alex" vs "Alexandra").
  if (a.length >= 3 && b.length >= 3 && (a.startsWith(b) || b.startsWith(a))) return "close";
  return "different";
}

export function matchNames(onId: string, onOrder: string): NameMatch {
  const id = normaliseName(onId);
  const order = normaliseName(onOrder);
  if (!id.length || !order.length) return "mismatch";
  const idFirst = id[0], idLast = id[id.length - 1];
  const oFirst = order[0], oLast = order[order.length - 1];

  const first = tokenCloseness(idFirst, oFirst);
  // Surname may be compound on one side ("Garcia Lopez" vs "Garcia"): accept any surname token pairing as close.
  let last = tokenCloseness(idLast, oLast);
  if (last === "different" && id.length > 1 && order.length > 1) {
    const idRest = id.slice(1), oRest = order.slice(1);
    if (idRest.some((t) => oRest.includes(t))) last = "close";
  }
  if (first === "same" && last === "same") return "match";
  if (first !== "different" && last !== "different") return "close";
  return "mismatch";
}
