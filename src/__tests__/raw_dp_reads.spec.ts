import { describe, it, expect } from "vitest";
import { Device } from "../model/device.js";
import { VACUUM_DP } from "../model/capabilities/vacuum-clean.js";
import { SUCTION_DP } from "../model/capabilities/suction.js";
import { decodeState } from "../model/capabilities/index.js";
import { rawDpCodec } from "../transport/raw-dp.js";
import { parseAiotDpReport } from "../transport/mqtt/dp-codec.js";
import type { CommandSink } from "../core/contracts.js";

/**
 * End-to-end read of a structured DP payload: the real transport codec, injected at bind, feeding a
 * capability's typed getter. Cross-layer by necessity — this is the one place both halves are in scope
 * at once, since the decorrelation guard bars `transport/` from any spec under `src/model`.
 *
 * The payload is synthesized from bytes here, not captured: `varint(len) ++ { #2 = state, … }`, with
 * trailing fields present so the reader is shown skipping past what it does not name.
 */
const noopSink: CommandSink = { dispatch: async () => undefined };

function workStatusPayload(state: number): string {
  const inner = Buffer.from([
    0x10,
    state, // #2 varint  — state
    0x1a,
    0x02,
    0x1a,
    0x00, // #3 message — a nested sub-status this read does not name
    0x72,
    0x02,
    0x22,
    0x00, // #14 message
    0x7a,
    0x00, // #15 message, empty
  ]);
  return Buffer.concat([Buffer.from([inner.length]), inner]).toString("base64");
}

function boundVacuum(state: number): Device {
  const dev = Device.fromRecord("T2351VAC", {
    model: "T2351",
    params: { [VACUUM_DP.WORK_STATUS]: workStatusPayload(state) },
  });
  dev.bindActions(
    { channel: 0, codec: "vacuum", paramIds: new Set([VACUUM_DP.WORK_STATUS]) },
    noopSink,
    undefined,
    undefined,
    rawDpCodec,
  );
  return dev;
}

describe("structured DP reads through the injected codec", () => {
  it("decodes the activity a vacuum reports, through the real codec", () => {
    expect(boundVacuum(3).vacuumClean?.()?.activity).toBe("docked");
    expect(boundVacuum(5).vacuumClean?.()?.activity).toBe("cleaning");
    expect(boundVacuum(7).vacuumClean?.()?.activity).toBe("returning");
  });

  it("re-reads live state per access — no value is frozen at bind time", () => {
    const dev = boundVacuum(5);
    const clean = dev.vacuumClean?.();
    expect(clean?.activity).toBe("cleaning");

    dev.applyParams({ [VACUUM_DP.WORK_STATUS]: workStatusPayload(3) });
    expect(clean?.activity).toBe("docked");
  });

  it("leaves the stored property undecoded — the meaning lives on the typed getter", () => {
    const dev = boundVacuum(3);
    expect(dev.getProperty("activity")?.value).toBe(workStatusPayload(3));
  });

  it("reads 'unknown' when bound without a codec rather than guessing", () => {
    const dev = Device.fromRecord("T2351VAC2", {
      model: "T2351",
      params: { [VACUUM_DP.WORK_STATUS]: workStatusPayload(3) },
    });
    dev.bindActions({ channel: 0, codec: "vacuum", paramIds: new Set([VACUUM_DP.WORK_STATUS]) }, noopSink);

    expect(dev.vacuumClean?.()?.activity).toBe("unknown");
  });

  it("a realtime report reaches the typed getters, codec included", () => {
    const payload = JSON.stringify({
      t: 1,
      protocol: 1,
      account_id: "<id>",
      device_sn: "<sn>",
      data: { [VACUUM_DP.WORK_STATUS]: workStatusPayload(7), [VACUUM_DP.BATTERY]: 61, [SUCTION_DP.BOOST_IQ]: true },
    });
    const dpParams = parseAiotDpReport({ head: { cmd: 65537 }, payload });
    expect(dpParams).toBeDefined();

    const states = decodeState({ source: "mqtt", raw: {}, dpParams }, new Set(["vacuum_clean", "suction"]));
    const params = Object.assign({}, ...states.map((s) => s.params)) as Record<number, string>;

    const dev = Device.fromRecord("T2351VAC4", { model: "T2351", params: {} });
    dev.applyParams(params);
    dev.bindActions(
      { channel: 0, codec: "vacuum", paramIds: new Set(Object.keys(params).map(Number)) },
      noopSink,
      undefined,
      undefined,
      rawDpCodec,
    );

    expect(dev.vacuumClean?.()?.activity).toBe("returning");
    expect(dev.vacuumClean?.()?.battery).toBe(61);
    expect(dev.suction?.()?.boostIq).toBe(true);
  });

  it("a device bound BEFORE its first report has no getters — the state alone does not create them", () => {
    const dev = Device.fromRecord("T2351VAC5", { model: "T2351", params: {} });
    dev.bindActions({ channel: 0, codec: "vacuum", paramIds: new Set() }, noopSink, undefined, undefined, rawDpCodec);
    expect("activity" in dev.vacuumClean!()!).toBe(false);

    dev.applyParams({ [VACUUM_DP.WORK_STATUS]: workStatusPayload(5) });

    expect(dev.getProperty("activity")?.value).toBe(workStatusPayload(5));
    expect("activity" in dev.vacuumClean!()!).toBe(false);

    dev.bindActions(
      { channel: 0, codec: "vacuum", paramIds: new Set([VACUUM_DP.WORK_STATUS]) },
      noopSink,
      undefined,
      undefined,
      rawDpCodec,
    );
    expect(dev.vacuumClean?.()?.activity).toBe("cleaning");
  });

  it("evidence-gates the getter like any other read", () => {
    const dev = Device.fromRecord("T2351VAC3", { model: "T2351", params: {} });
    dev.bindActions({ channel: 0, codec: "vacuum", paramIds: new Set() }, noopSink, undefined, undefined, rawDpCodec);

    expect("activity" in dev.vacuumClean!()!).toBe(false);
  });
});

/**
 * A scene list that exists only on the realtime feed. The member behind it is gated on DP 180 being
 * evidence, which a robot's cloud record never makes it, so the schema has to see realtime evidence for
 * the report to be stored under the member's name at all. Synthesized: one scene, id 5, valid.
 */
function sceneReport(): string {
  const id = Buffer.from([0x0a, 0x02, 0x08, 0x05]);
  const info = Buffer.concat([id, Buffer.from([0x10, 0x01])]);
  const body = Buffer.concat([Buffer.from([0x22, info.length]), info]);
  return Buffer.concat([Buffer.from([body.length]), body]).toString("base64");
}

describe("a structured read whose DP arrives only over realtime", () => {
  const bindAiot = (dev: Device, ids: number[]) =>
    dev.bindActions(
      { channel: 0, codec: "vacuum", category: "eufy_home", paramIds: new Set(ids) },
      noopSink,
      undefined,
      undefined,
      rawDpCodec,
    );

  it("reads the scenes when the record's realtime params already carry DP 180", () => {
    const dev = Device.fromRecord("T2351VAC", {
      model: "T2351",
      params: {},
      dpParams: { [VACUUM_DP.SCENES]: sceneReport() },
    });
    dev.applyParams({ [VACUUM_DP.SCENES]: sceneReport() });
    bindAiot(dev, [VACUUM_DP.SCENES]);

    expect(
      dev
        .vacuumClean?.()
        ?.scenes?.()
        ?.map((s) => s.id),
    ).toEqual([5]);
  });

  it("reads the scenes once a re-resolve sees DP 180 that arrived after the device was built", () => {
    const dev = Device.fromRecord("T2351VAC", { model: "T2351", params: {} });
    dev.applyParams({ [VACUUM_DP.SCENES]: sceneReport() });
    bindAiot(dev, [VACUUM_DP.SCENES]);
    expect(dev.vacuumClean?.()?.scenes?.()).toBeUndefined();

    const dpParams = { [VACUUM_DP.SCENES]: sceneReport() };
    dev.reresolve({ model: "T2351", params: {}, dpParams });
    dev.applyParams(dpParams);
    bindAiot(dev, [VACUUM_DP.SCENES]);

    expect(
      dev
        .vacuumClean?.()
        ?.scenes?.()
        ?.map((s) => s.id),
    ).toEqual([5]);
  });
});
