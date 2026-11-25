import { queuedCourierProgress } from "@/courier/progress";

describe("offline food progress", () => {
  it("restores queued travel and arrival for a previously verified pickup", () => {
    expect(queuedCourierProgress("picked_up", ["en-route", "arrive"])).toBe("arrived");
  });

  it("keeps a queued pickup or proof from appearing confirmed", () => {
    expect(queuedCourierProgress("at_vendor", ["pickup", "en-route"])).toBe("at_vendor");
    expect(queuedCourierProgress("en_route", ["arrive", "deliver"])).toBe("arrived");
  });
});
