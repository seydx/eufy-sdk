import { describe, it, expect } from "vitest";
import { PushClient } from "../push-client.js";
import type { PushEvent } from "../types.js";

/**
 * A push's identity can ride the app_data envelope while its detail rides the base64 `payload` entry,
 * and that entry may nest a further `payload`. Every shape below goes through `handleDataMessage`, so
 * the envelope the producer emits and the levels the normaliser walks are exercised together.
 */
const STATION = "T8000P0000000000";
const DEVICE = "T8000P0000000001";

const encoded = (json: unknown): string => Buffer.from(JSON.stringify(json) + "\0").toString("base64");

function pushOf(appData: { key: string; value: string }[]): PushEvent {
  const client = new PushClient({ androidId: "1", securityToken: "2" } as never);
  const seen: PushEvent[] = [];
  client.on("push", (e: PushEvent) => seen.push(e));
  (client as unknown as { handleDataMessage(o: unknown): void }).handleDataMessage({ appData });
  expect(seen).toHaveLength(1);
  return seen[0]!;
}

describe("push envelope keeps device identity", () => {
  it("takes the serials from the envelope when the payload entry carries none", () => {
    const event = pushOf([
      { key: "device_sn", value: DEVICE },
      { key: "station_sn", value: STATION },
      { key: "payload", value: encoded({ event_type: 3301, channel: 0 }) },
    ]);
    expect(event.deviceSn).toBe(DEVICE);
    expect(event.stationSn).toBe(STATION);
    expect(event.eventType).toBe(3301);
  });

  it("keeps the detail of a payload entry that nests its own payload", () => {
    const event = pushOf([
      { key: "station_sn", value: STATION },
      {
        key: "payload",
        value: encoded({ device_sn: DEVICE, payload: { event_type: 3102, pic_url: "https://example.test/t.jpg" } }),
      },
    ]);
    expect(event.deviceSn).toBe(DEVICE);
    expect(event.stationSn).toBe(STATION);
    expect(event.eventType).toBe(3102);
    expect(event.thumbnailUrl).toBe("https://example.test/t.jpg");
    expect(event.thumbnailCandidate?.attribution).toEqual({ kind: "device", deviceSn: DEVICE });
  });
});
