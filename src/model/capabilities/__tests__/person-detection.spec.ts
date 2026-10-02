import { PERSON_DETECTION } from "../person-detection.js";
import { describeCapabilities, detectCapabilities } from "../index.js";
import type { Capability } from "../../types.js";

describe("person_detection capability module", () => {
  it("declares the capability + schema", () => {
    expect(PERSON_DETECTION.capability).toBe("person_detection");
    // Push events are the whole read surface; no owned camera reports a detection state param.
    expect(PERSON_DETECTION.properties).toEqual([]);
  });

  it("advertises semantic person events on the camera baseline without inventing sensor support", () => {
    expect(detectCapabilities({ params: {} }, "camera")).toContain("person_detection");
    expect(detectCapabilities({ params: {} }, "sensor")).not.toContain("person_detection");
    expect(PERSON_DETECTION.events?.map(({ emit }) => emit)).toEqual([
      "personDetected",
      "personDetected",
      "strangerDetected",
    ]);
  });

  /**
   * 3111 and 3112 are declared in `HB3PairedDevicePushEvent` and in no other family's vocabulary, so
   * a unit that stands alone is not in the population that issues them. 3102 is declared in all three
   * camera vocabularies and carries no claim, which is what keeps `personDetected` on every camera.
   */
  describe("identified-person events claimed on station attachment", () => {
    // One bound object stands for a live device: a capability with no surface is described alongside
    // the ones an object was walked for, never on an unbound device whose details stay empty.
    const events = (homeBaseAttached: boolean): readonly string[] =>
      describeCapabilities({ motion: {} } as never, {
        codec: "camera",
        capabilities: new Set<Capability>(["person_detection", "motion"]),
        homeBaseAttached,
      }).find((entry) => entry.capability === "person_detection")!.events;

    it("keeps a face detection on a standalone camera", () => {
      expect(events(false)).toContain("personDetected");
    });

    it("withdraws the stranger event from a standalone camera", () => {
      expect(events(false)).not.toContain("strangerDetected");
    });

    it("describes both on a camera that hangs off a station", () => {
      expect(events(true)).toEqual(expect.arrayContaining(["personDetected", "strangerDetected"]));
    });
  });
});
