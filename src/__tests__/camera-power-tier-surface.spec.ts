import { expect, it } from "vitest";
import { cameraPowerTier } from "../index.js";

it("publishes the camera power tier at the package entry point", () => {
  expect(cameraPowerTier("T8423", new Set(["camera", "battery"]))).toBe("wired");
});
