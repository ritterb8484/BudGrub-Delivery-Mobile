import { matchNames } from "@/id/nameMatch";
import { ageOn, DEFAULT_ID_RULES, spokenResult, validateId, type IdDocument } from "@/id/validator";

const today = new Date(2026, 10, 10); // 10 Nov 2026 local
const doc = (o: Partial<IdDocument> = {}): IdDocument => ({ name: "Jamal Pierce", dob: "1990-04-02", idType: "drivers_license", expires: "2030-04-02", last4: "5678", ...o });
const rules = DEFAULT_ID_RULES;

describe("validateId", () => {
  it("passes a valid, unexpired 21+ ID with a matching name", () => {
    const r = validateId(doc(), "Jamal Pierce", rules, { today });
    expect(r).toMatchObject({ ok: true, reasons: [], nameMatch: "match", age: 36 });
  });

  it("is 21 on the birthday, 20 the day before", () => {
    expect(validateId(doc({ dob: "2005-11-10" }), "Jamal Pierce", rules, { today }).ok).toBe(true);
    const r = validateId(doc({ dob: "2005-11-11" }), "Jamal Pierce", rules, { today });
    expect(r.ok).toBe(false);
    expect(r.reasons.map((x) => x.code)).toEqual(["UNDER_AGE"]);
  });

  it("accepts an ID on its expiry date and rejects it the day after", () => {
    expect(validateId(doc({ expires: "2026-11-10" }), "Jamal Pierce", rules, { today }).ok).toBe(true);
    expect(validateId(doc({ expires: "2026-11-09" }), "Jamal Pierce", rules, { today }).reasons[0].code).toBe("ID_EXPIRED");
    expect(validateId(doc({ expires: null }), "Jamal Pierce", rules, { today }).reasons[0].code).toBe("EXPIRY_MISSING");
  });

  it("rejects document types not on the accepted list", () => {
    const r = validateId(doc({ idType: "student_id" }), "Jamal Pierce", rules, { today });
    expect(r.reasons.map((x) => x.code)).toContain("ID_TYPE_NOT_ACCEPTED");
    // Server-provided list overrides the default.
    expect(validateId(doc({ idType: "passport" }), "Jamal Pierce", { acceptedTypes: ["drivers_license"], minAge: 21 }, { today }).ok).toBe(false);
  });

  it("requires manual confirmation for a minor name variance, never for a mismatch", () => {
    const close = validateId(doc({ name: "Jamall Pierce" }), "Jamal Pierce", rules, { today });
    expect(close).toMatchObject({ ok: false, needsNameConfirmation: true, nameMatch: "close", reasons: [] });
    expect(validateId(doc({ name: "Jamall Pierce" }), "Jamal Pierce", rules, { today, nameConfirmed: true }).ok).toBe(true);
    const wrong = validateId(doc({ name: "Kevin Smith" }), "Jamal Pierce", rules, { today, nameConfirmed: true });
    expect(wrong.ok).toBe(false);
    expect(wrong.reasons[0].code).toBe("NAME_MISMATCH");
  });

  it("collects every failing reason (no override)", () => {
    const r = validateId(doc({ name: "Kevin Smith", dob: "2010-01-01", expires: "2020-01-01" }), "Jamal Pierce", rules, { today });
    expect(r.reasons.map((x) => x.code).sort()).toEqual(["ID_EXPIRED", "NAME_MISMATCH", "UNDER_AGE"]);
    expect(r.needsNameConfirmation).toBe(false);
    expect(spokenResult(r, "Jamal Pierce")).toMatch(/^Do not hand over\./);
  });

  it("speaks a short pass sentence with the first name", () => {
    expect(spokenResult({ ok: true, reasons: [] }, "Jamal Pierce")).toBe("ID verified. You may hand the sealed order to Jamal.");
  });

  it("computes age across month boundaries", () => {
    expect(ageOn("2000-02-29", "2021-02-28")).toBe(20);
    expect(ageOn("2000-02-29", "2021-03-01")).toBe(21);
  });
});

describe("matchNames", () => {
  it.each([
    ["Jamal Marcus Pierce", "Jamal Pierce", "match"],
    ["JAMAL PIERCE", "jamal pierce", "match"],
    ["Élodie Tremblay", "Elodie Tremblay", "match"],
    ["Sean O'Brien", "Sean OBrien", "close"],
    ["Sean O'Brien", "Sean O Brien", "match"],
    ["Jon Pierce", "Jonathan Pierce", "close"],
    ["Maria Garcia Lopez", "Maria Garcia", "close"],
    ["Jamal Peirce", "Jamal Pierce", "close"],
    ["Kevin Pierce", "Jamal Pierce", "mismatch"],
    ["Jamal Smith", "Jamal Pierce", "mismatch"],
    ["", "Jamal Pierce", "mismatch"],
  ])("%s vs %s → %s", (a, b, expected) => {
    expect(matchNames(a, b)).toBe(expected);
  });
});
