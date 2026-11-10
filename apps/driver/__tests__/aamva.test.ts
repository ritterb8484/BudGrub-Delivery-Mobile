import { AamvaParseError, looksLikeAamva, parseAamva, parseAamvaDate } from "@/id/aamva";

// AAMVA 2016 (v8/v9 style) Nevada DL, synthetic data.
const NV_DL =
  "@\n\x1e\rANSI 636049090002DL00410278ZN03190008DLDAQ1102345678\nDCSPIERCE\nDDEN\nDACJAMAL\nDDFN\nDADMARCUS\nDDGN\nDCAC\nDCBNONE\nDCDNONE\nDBD07012022\nDBB04021990\nDBA04022030\nDBC1\nDAU071 in\nDAYBRO\nDAG100 MAIN ST\nDAILAS VEGAS\nDAJNV\nDAK891010000  \nDCF1234567890\nDCGUSA\nDAW180\nDCK1234\nDDB12102018\rZNZNA\r";

// State ID card subfile.
const STATE_ID =
  "@\n\x1e\rANSI 636014080102ID00410240ZC02810024IDDAQS1234567\nDCSGARCIA LOPEZ\nDACMARIA\nDADNONE\nDBB11151985\nDBA11152027\nDAJCA\nDCGUSA\n";

// Version 1 with DAA full name only.
const V1 = "@\n\x1e\rANSI 6360000102DL00390187DLDAADOE,JOHN,Q\nDAQD1234567\nDBB19800115\nDBA20300115\nDAJTX\n";

// Canadian (CCYYMMDD).
const CAN = "@\n\x1e\rANSI 636012070002DL00410200DLDAQ12345-67890\nDCSTREMBLAY\nDACÉLODIE\nDBB19950630\nDBA20290630\nDCGCAN\nDAJON\n";

describe("AAMVA parser", () => {
  it("parses a Nevada driver's licence", () => {
    const p = parseAamva(NV_DL);
    expect(p).toMatchObject({
      documentType: "drivers_license",
      firstName: "Jamal",
      middleName: "Marcus",
      lastName: "Pierce",
      fullName: "Jamal Marcus Pierce",
      dob: "1990-04-02",
      expires: "2030-04-02",
      idNumber: "1102345678",
      last4: "5678",
      jurisdiction: "NV",
      country: "USA",
      aamvaVersion: 9,
    });
  });

  it("detects a state ID card and keeps compound surnames", () => {
    const p = parseAamva(STATE_ID);
    expect(p.documentType).toBe("state_id");
    expect(p.lastName).toBe("Garcia Lopez");
    expect(p.middleName).toBeNull(); // "NONE"
    expect(p.dob).toBe("1985-11-15");
  });

  it("falls back to DAA and the other date order for version 1 cards", () => {
    const p = parseAamva(V1);
    expect(p).toMatchObject({ firstName: "John", middleName: "Q", lastName: "Doe", dob: "1980-01-15", expires: "2030-01-15", last4: "4567" });
  });

  it("reads Canadian dates as CCYYMMDD", () => {
    const p = parseAamva(CAN);
    expect(p.dob).toBe("1995-06-30");
    expect(p.country).toBe("CAN");
    expect(p.firstName).toBe("Élodie");
  });

  it("rejects non-licence barcodes and incomplete data", () => {
    expect(() => parseAamva("1A4060300003B01000012345")).toThrow(AamvaParseError);
    expect(() => parseAamva("@\n\x1e\rANSI 636049090002DL00410278DLDCSPIERCE\nDACJAMAL\nDAQ123\n")).toThrow(/Date of birth/);
    expect(looksLikeAamva(NV_DL)).toBe(true);
    expect(looksLikeAamva("https://example.com")).toBe(false);
  });

  it("validates calendar dates", () => {
    expect(parseAamvaDate("02302000", "USA")).toBeNull();
    expect(parseAamvaDate("02292000", "USA")).toBe("2000-02-29");
    expect(parseAamvaDate("2000", "USA")).toBeNull();
  });
});
