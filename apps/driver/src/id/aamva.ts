/**
 * AAMVA DL/ID card design standard parser for the PDF417 barcode on the back of US (and Canadian) licences and state IDs.
 *
 * Handles versions 1–10: header "@\n\x1e\rANSI " (some jurisdictions use "AAMVA"), subfile designators DL / ID, and the
 * data elements we need: DCS/DAB (family name), DAC/DCT/DAA (given names), DAD (middle), DBB (DOB), DBA (expiry),
 * DAQ (ID number), DCG (country), DAJ (jurisdiction). Dates are MMDDCCYY for USA and CCYYMMDD for Canada.
 *
 * Nothing here persists anything: the raw string is parsed in memory and only the fields below leave this module.
 */

export type AamvaDocumentType = "drivers_license" | "state_id";

export interface ParsedLicence {
  documentType: AamvaDocumentType;
  firstName: string;
  middleName: string | null;
  lastName: string;
  /** "First Middle Last" for display and name matching. */
  fullName: string;
  /** ISO yyyy-mm-dd */
  dob: string;
  /** ISO yyyy-mm-dd */
  expires: string | null;
  idNumber: string;
  last4: string;
  jurisdiction: string | null;
  country: "USA" | "CAN" | string;
  aamvaVersion: number | null;
}

export class AamvaParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AamvaParseError";
  }
}

const ELEMENT = /^(D[A-Z]{2}|Z[A-Z]{2})(.*)$/;

function cleanValue(v: string): string {
  return v.replace(/[\x00-\x1f]/g, "").trim();
}

function isTruncationMarker(v: string) {
  return v === "NONE" || v === "unavl" || v === "UNAVL";
}

/** Parse an AAMVA date. `country` decides the order; we also sanity-check and fall back to the other order. */
export function parseAamvaDate(raw: string, country: string): string | null {
  const v = raw.replace(/\D/g, "");
  if (v.length !== 8) return null;
  const mdy = { y: v.slice(4, 8), m: v.slice(0, 2), d: v.slice(2, 4) };
  const ymd = { y: v.slice(0, 4), m: v.slice(4, 6), d: v.slice(6, 8) };
  const valid = (p: { y: string; m: string; d: string }) => {
    const y = Number(p.y), m = Number(p.m), d = Number(p.d);
    if (y < 1900 || y > 2200 || m < 1 || m > 12 || d < 1 || d > 31) return false;
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
  };
  const order = country === "CAN" ? [ymd, mdy] : [mdy, ymd];
  const hit = order.find(valid);
  return hit ? `${hit.y}-${hit.m}-${hit.d}` : null;
}

function titleCase(s: string) {
  return s
    .toLowerCase()
    .split(/(\s+|-|')/)
    .map((w) => (/^\p{Ll}/u.test(w) ? w[0].toUpperCase() + w.slice(1) : w))
    .join("");
}

export function looksLikeAamva(raw: string): boolean {
  return /ANSI\s?\d{6}|AAMVA\d{6}/.test(raw) && /\bD(AQ|BB|CS|AA)/.test(raw.replace(/[\r\n\x1e]/g, " ").replace(/\s(DL|ID)(?=D[A-Z]{2})/g, " "));
}

export function parseAamva(raw: string): ParsedLicence {
  if (!raw || raw.length < 30) throw new AamvaParseError("Barcode is empty or too short");
  const headerMatch = raw.match(/(ANSI ?|AAMVA)(\d{6})(\d{2})(\d{2})?(\d{2})?/);
  if (!headerMatch) throw new AamvaParseError("Not an AAMVA licence barcode");
  const version = Number(headerMatch[3]);

  // Subfile type: the designator table follows the header ("DL0041..." / "ID0041..."); the subfile itself also starts
  // with its type immediately before the first element ("DLDAQ...").
  const afterHeader = raw.slice((headerMatch.index ?? 0) + headerMatch[0].length);
  const designator = afterHeader.match(/^(DL|ID)\d{8}/)?.[1] ?? raw.match(/(?:^|[\n\r\x1e])(DL|ID)(?=D[A-Z]{2})/)?.[1] ?? null;

  const fields = new Map<string, string>();
  const lines = raw.split(/[\n\r\x1e]+/);
  for (let line of lines) {
    // First element of a subfile is prefixed with the subfile type, and on the first line also the header/table.
    const subStart = line.search(/(DL|ID)(?=D[A-Z]{2})/);
    if (subStart >= 0 && (subStart === 0 || /ANSI|AAMVA|\d{8}$/.test(line.slice(0, subStart)))) line = line.slice(subStart + 2);
    const m = line.match(ELEMENT);
    if (!m) continue;
    const [, code, value] = m;
    if (!fields.has(code)) fields.set(code, cleanValue(value));
  }

  const country = (fields.get("DCG") || "USA").toUpperCase();
  let last = fields.get("DCS") || fields.get("DAB") || "";
  let first = fields.get("DAC") || fields.get("DCT") || "";
  let middle = fields.get("DAD") || "";

  // Version 1 and some jurisdictions only carry DAA "LAST,FIRST,MIDDLE" (or "LAST$FIRST$MIDDLE").
  if ((!last || !first) && fields.get("DAA")) {
    const parts = fields.get("DAA")!.split(/[,$]/).map((p) => p.trim()).filter(Boolean);
    last = last || parts[0] || "";
    first = first || parts[1] || "";
    middle = middle || parts.slice(2).join(" ");
  }
  // Older DCT carries "FIRST MIDDLE" (or "FIRST,MIDDLE") when DAD is absent.
  if (first && !fields.get("DAC") && !middle) {
    const parts = first.split(/[,\s]+/).filter(Boolean);
    first = parts[0] ?? first;
    middle = parts.slice(1).join(" ");
  }
  if (isTruncationMarker(middle)) middle = "";

  const dobRaw = fields.get("DBB");
  const idNumber = (fields.get("DAQ") || "").replace(/\s/g, "");
  if (!last || !first) throw new AamvaParseError("Name not found on the barcode");
  if (!dobRaw) throw new AamvaParseError("Date of birth not found on the barcode");
  const dob = parseAamvaDate(dobRaw, country);
  if (!dob) throw new AamvaParseError("Date of birth on the barcode is not a valid date");
  if (!idNumber) throw new AamvaParseError("ID number not found on the barcode");
  const expiresRaw = fields.get("DBA");
  const expires = expiresRaw ? parseAamvaDate(expiresRaw, country) : null;

  // DL subfile → driver's licence. ID subfile → state ID card. A DCA (vehicle class) also implies DL.
  const documentType: AamvaDocumentType = designator === "ID" && !fields.get("DCA") ? "state_id" : "drivers_license";

  const firstName = titleCase(first);
  const lastName = titleCase(last);
  const middleName = middle ? titleCase(middle) : null;
  return {
    documentType,
    firstName,
    middleName,
    lastName,
    fullName: [firstName, middleName, lastName].filter(Boolean).join(" "),
    dob,
    expires,
    idNumber,
    last4: idNumber.slice(-4),
    jurisdiction: fields.get("DAJ") || null,
    country,
    aamvaVersion: Number.isFinite(version) ? version : null,
  };
}
