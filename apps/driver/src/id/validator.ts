import type { IdCheckReason } from "@/api/types";
import { matchNames, type NameMatch } from "./nameMatch";

/**
 * On-device ID validation for immediate feedback at the door (BUD-101). The server enforces the same rules on the
 * `id-check` stop action and refuses hand-over without a passing check, so this never grants anything by itself.
 *
 * Rules (cached with the trip for offline use, BUD-124):
 *  - document type on the accepted list (NAC 678B.306; the list comes from the API's `idTypes`),
 *  - not expired (valid through the expiry date),
 *  - age ≥ minAge (21),
 *  - name matches the ordering customer; a minor variance needs the agent's manual confirmation.
 * There is no override: a failed rule blocks hand-over.
 */

/** Fallback when no cached rules exist yet. The API's idTypes list is authoritative. */
export const DEFAULT_ID_RULES: IdRules = {
  acceptedTypes: ["drivers_license", "state_id", "passport", "military_id"],
  minAge: 21,
};

export interface IdRules {
  acceptedTypes: string[];
  minAge: number;
}

export interface IdDocument {
  name: string;
  /** ISO yyyy-mm-dd */
  dob: string;
  idType: string;
  /** ISO yyyy-mm-dd or null when not printed/scanned */
  expires: string | null;
  last4: string | null;
}

export interface LocalIdResult {
  ok: boolean;
  /** true when the only open issue is a minor name variance the agent has not confirmed yet */
  needsNameConfirmation: boolean;
  nameMatch: NameMatch;
  age: number | null;
  reasons: IdCheckReason[];
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Local calendar date as yyyy-mm-dd (the agent's local day decides "expired" and "birthday today"). */
export function localIsoDate(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

/** yyyy-mm-dd that is also a real calendar date ("1990-13-45" and "2030-02-31" are not). */
export function isRealIsoDate(s: string): boolean {
  if (!ISO_DATE.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** Manual entry: digits typed on the number pad become YYYY-MM-DD; the dashes are inserted for the agent. */
export function formatDateInput(v: string): string {
  const d = v.replace(/\D/g, "").slice(0, 8);
  return [d.slice(0, 4), d.slice(4, 6), d.slice(6, 8)].filter(Boolean).join("-");
}

export function ageOn(dobIso: string, todayIso: string): number {
  const [by, bm, bd] = dobIso.split("-").map(Number);
  const [ty, tm, td] = todayIso.split("-").map(Number);
  let age = ty - by;
  if (tm < bm || (tm === bm && td < bd)) age--;
  return age;
}

export function validateId(doc: IdDocument, recipient: string, rules: IdRules, opts: { today?: Date; nameConfirmed?: boolean } = {}): LocalIdResult {
  const today = localIsoDate(opts.today ?? new Date());
  const reasons: IdCheckReason[] = [];

  if (!rules.acceptedTypes.includes(doc.idType)) {
    reasons.push({ code: "ID_TYPE_NOT_ACCEPTED", message: `${doc.idType.replace(/_/g, " ")} is not an accepted ID type.` });
  }

  let age: number | null = null;
  if (!isRealIsoDate(doc.dob)) {
    reasons.push({ code: "DOB_INVALID", message: "Date of birth is missing or not a valid date." });
  } else if (doc.dob > today) {
    reasons.push({ code: "DOB_INVALID", message: "Date of birth is in the future." });
  } else {
    age = ageOn(doc.dob, today);
    if (age < rules.minAge) reasons.push({ code: "UNDER_AGE", message: `Customer is ${age}. They must be ${rules.minAge} or older.` });
  }

  if (doc.expires === null || doc.expires === "") {
    reasons.push({ code: "EXPIRY_MISSING", message: "Expiry date is required to confirm the ID is unexpired." });
  } else if (!isRealIsoDate(doc.expires)) {
    reasons.push({ code: "EXPIRY_INVALID", message: "Expiry date is not a valid date." });
  } else if (doc.expires < today) {
    reasons.push({ code: "ID_EXPIRED", message: `ID expired on ${doc.expires}.` });
  }

  const nameMatch = matchNames(doc.name, recipient);
  let needsNameConfirmation = false;
  if (nameMatch === "mismatch") {
    reasons.push({ code: "NAME_MISMATCH", message: `Name on ID does not match ${recipient}. Nobody else may receive the order.` });
  } else if (nameMatch === "close" && !opts.nameConfirmed) {
    needsNameConfirmation = true;
  }

  return {
    ok: reasons.length === 0 && !needsNameConfirmation,
    needsNameConfirmation: reasons.length === 0 && needsNameConfirmation,
    nameMatch,
    age,
    reasons,
  };
}

/** Sentence read aloud by expo-speech so the agent can confirm without looking at the screen. */
export function spokenResult(r: { ok: boolean; reasons: IdCheckReason[] }, recipient: string): string {
  if (r.ok) return `ID verified. You may hand the sealed order to ${recipient.split(" ")[0]}.`;
  const why = r.reasons.map((x) => x.message).join(" ");
  return `Do not hand over. ${why}`;
}
