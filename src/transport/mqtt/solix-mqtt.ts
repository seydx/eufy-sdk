/**
 * Live telemetry for Anker Solix devices over the AWS-IoT MQTT plane.
 *
 * The transport is the shared `SecureMqtt` — the exact same anker AWS-IoT broker + per-user
 * client-cert mutual TLS the eufy device path uses; a Solix account's `get_user_mqtt_info` result maps
 * straight onto {@link SecureMqttCredentials}. Solix devices publish telemetry continuously on
 * `dt/{app_name}/{product_code}/{device_sn}/param_info` as an **ff09 TLV frame** (the same framing
 * family as {@link parseFf09SettingsResponse}), so this module only adds the Solix topic + a small
 * ff09 param decoder on top of the reused transport.
 *
 * Frame layout (observed on a Smart Meter Gen 2 / AE1X0):
 *   ff09 | len(u16 LE, incl. trailing XOR checksum) | 5-byte header | TLV fields | xor
 * each TLV field is `tag(1) | len(1) | value(len)`; measurement fields carry `type(1) | 4 bytes`,
 * type `0x05` = float32 LE. Field `a2` is the device serial (ASCII after a leading type byte).
 */
import { EventEmitter } from "node:events";

import { SecureMqtt, type SecureMqttCredentials } from "./secure-mqtt.js";
import { walkFf09Tlv } from "../ff09.js";
import { buildAppShapedClientId, mqttUuidFrom } from "./app-client-id.js";
import { solixDeviceTopics, solixUserTopics } from "./topics.js";
import { genId, type Logger } from "../../core/index.js";

/** A decoded telemetry channel: the raw value plus float/uint interpretations of a 4-byte payload. */
export interface SolixChannel {
  /** The leading type byte (`0x05` = float32 LE for the meter's measurement channels). */
  type: number;
  raw: Buffer;
  /** Present when the payload is 4 bytes: little-endian float32. */
  float?: number;
  /** Present when the payload is 4 bytes: little-endian uint32. */
  uint?: number;
}

/** A parsed ff09 param frame: the device serial (from `a2`) + the raw TLV field map keyed by tag. */
export interface SolixParamFrame {
  deviceSn?: string;
  /** tag byte → value bytes (still including the per-field leading type byte for measurement fields). */
  fields: Map<number, Buffer>;
}

/**
 * Telemetry field tags for the Smart Meter (AE1X0) that we emit under a stable NAME, keyed by ff09 tag
 * byte. Only tags whose tag→name binding is CONFIRMED against a live frame live here:
 *
 * - `0xac` = `meterVoltageL1` — confirmed against live single-phase data (a nominal mains voltage).
 *
 * Every other measurement tag still surfaces as `channel_<hex tag>` (see {@link solixReadings}), so
 * nothing on the wire is lost — a caller reads unconfirmed tags there. The names are deliberately NOT
 * asserted for the rest: the app exposes the field *list*, but the tag→name *binding* below is a
 * structural inference until a known-load capture pins it, and a mislabelled live float is worse than an
 * honest `channel_<tag>`. The recovered candidates, to re-add one line each (moving the tag from this
 * comment to the map above) as a known-load capture confirms each binding:
 *
 *   0xa8 meterPowerL1   0xa9 meterPowerL2   0xaa meterPowerL3   0xab meterPowerTotal
 *   0xad meterVoltageL2 0xae meterVoltageL3 0xaf meterCurrentL1 0xb0 meterCurrentL2
 *   0xb1 meterCurrentL3 0xb2 meterCurrentTotal 0xb3 meterImportEnergy 0xb4 meterExportEnergy
 */
export const SOLIX_METER_FIELD_NAMES: Readonly<Record<number, string>> = {
  0xac: "meterVoltageL1",
};

/** Interpret one TLV value as a telemetry channel (leading type byte + payload). */
export function readSolixChannel(value: Buffer | undefined): SolixChannel | undefined {
  if (!value || value.length < 1) return undefined;
  const raw = value.subarray(1);
  const ch: SolixChannel = { type: value[0]!, raw };
  if (raw.length === 4) {
    ch.float = raw.readFloatLE(0);
    ch.uint = raw.readUInt32LE(0);
  }
  return ch;
}

/**
 * Decode an ff09 Solix param frame into its serial + TLV field map. Returns `null` for a non-ff09
 * buffer, a length field that doesn't fit, or a bad checksum. Validates the trailing XOR checksum first
 * (so a corrupted frame is rejected rather than yielding plausible floats), then walks `tag|len|value`
 * from the first `0xa1` tag to the declared length minus the checksum byte via the shared
 * `walkFf09Tlv` (bounded by `end`, so a field length can't overrun into the checksum).
 */
export function decodeSolixParamFrame(buf: Buffer): SolixParamFrame | null {
  if (buf.length < 10 || buf[0] !== 0xff || buf[1] !== 0x09) return null;
  const declaredLen = buf.readUInt16LE(2);
  if (declaredLen < 5 || declaredLen > buf.length) return null;
  let xor = 0;
  for (let i = 0; i < declaredLen; i++) xor ^= buf[i]!;
  if (xor !== 0) return null;
  const end = declaredLen - 1;
  const start = buf.indexOf(0xa1, 4);
  if (start < 0 || start >= end) return { fields: new Map() };
  const fields = walkFf09Tlv(buf, start, end);
  let deviceSn: string | undefined;
  const a2 = fields.get(0xa2);
  if (a2 && a2.length > 1) deviceSn = a2.subarray(1).toString("latin1").replace(/\0+$/, "") || undefined;
  return { deviceSn, fields };
}

/**
 * Reduce a param frame to named + raw telemetry values. Tags below `0xa6` are skipped — `a1`/`a2`/`a3`
 * carry the field count, the serial and the status, not measurements. A measurement channel is one whose
 * leading type byte is `0x05` (float32 LE over a 4-byte payload); any other type is a non-measurement
 * param and contributes nothing. Each measurement is emitted under `channel_<hex tag>`, and additionally
 * under its name when the tag has a confirmed one in {@link SOLIX_METER_FIELD_NAMES}.
 */
export function solixReadings(frame: SolixParamFrame): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [tag, value] of frame.fields) {
    if (tag < 0xa6) continue;
    const ch = readSolixChannel(value);
    if (ch?.type !== 0x05 || ch.float === undefined) continue;
    out[`channel_${tag.toString(16)}`] = ch.float;
    const name = SOLIX_METER_FIELD_NAMES[tag];
    if (name) out[name] = ch.float;
  }
  return out;
}

/** A live telemetry sample emitted by {@link SolixMqtt} as a `reading` event. */
export interface SolixReading {
  deviceSn: string;
  productCode: string;
  topic: string;
  frame: SolixParamFrame;
  values: Record<string, number>;
}

/** The minimum device shape {@link SolixMqtt.watch} needs (as returned by `SolixClient.getDevices`). */
export interface SolixMqttDevice {
  device_sn: string;
  product_code: string;
}

/** Options for {@link SolixMqtt}. */
export interface SolixMqttOptions {
  /** `get_user_mqtt_info` result — carries endpoint, cert/key, app_name, thing_name, user_id. */
  mqttInfo: SecureMqttCredentials;
  /** Override the MQTT clientId. Defaults to the cert CN (`thing_name`), distinct from the app's id. */
  clientId?: string;
  /**
   * Account/user id (40-hex) for the arming `account_id` + heartbeat topic. Defaults to
   * `mqttInfo.user_id`; set it if the credentials omit it.
   */
  userId?: string;
  /**
   * How often (ms) to re-send the device-info arming request that keeps realtime telemetry flowing.
   * The device stops pushing `param_info` when no client keeps requesting it (the app re-arms on every
   * foreground resume + a periodic heartbeat), so a passive subscriber goes silent after the server's
   * reporting window closes. Default 25s — inside the observed ~30s cadence with keepalive 60. Set `0`
   * to disable arming (subscribe-only, the old behaviour).
   */
  armIntervalMs?: number;
  /**
   * The `head.client_id` stamped into the command/heartbeat envelopes — the app-shaped
   * `android-{app_name}-{user_id}-{mqttUuid}-{ts}` (see {@link buildAppShapedClientId}). Defaults to
   * that shape built from {@link mqttUuid}. Pass this to pin the whole string.
   */
  appClientId?: string;
  /**
   * Stable 16-hex install UUID for the app-shaped client id. Defaults to one derived deterministically
   * from the user id ({@link mqttUuidFrom}) — no storage needed, so the broker sees one stable client
   * across restarts.
   *
   * The trade this makes: the default seed is the **account** id, which every client on that account
   * shares, so two clients on one account derive the same uuid → the same `client_id`, and the broker
   * evicts one to admit the other (they take the channel from each other indefinitely). Restart
   * stability is the common case and this is the deliberate default, but pass an explicit `mqttUuid`
   * (per host/install) when more than one client runs on the same account, to be told apart.
   */
  mqttUuid?: string;
  /** The account's `site_id` for the `power_site` heartbeat. Omitted from the frame when unknown. */
  siteId?: string;
  logger?: Logger;
}

/**
 * Subscribe to a Solix device's live telemetry and emit decoded `reading` events. Reuses
 * `SecureMqtt` for the connection; adds only the Solix data topic + ff09 param decoding.
 *
 *   const mqtt = new SolixMqtt({ mqttInfo: await solix.getUserMqttInfo() });
 *   mqtt.on("reading", (r) => console.log(r.deviceSn, r.values.meterVoltageL1));
 *   await mqtt.watch(device);   // device = a SolixClient.getDevices() entry
 */
export class SolixMqtt extends EventEmitter {
  private readonly transport: SecureMqtt;
  private readonly appName: string;
  private readonly userId?: string;
  private readonly appClientId: string;
  private readonly armIntervalMs: number;
  private readonly logger?: Logger;
  private readonly siteId?: string;
  private readonly watched = new Map<string, SolixMqttDevice>();
  private seq = 0;
  private armTimer?: ReturnType<typeof setInterval>;

  /**
   * Bind to one account's MQTT plane. The envelope `client_id` takes the app's shape
   * (`android-{app}-{uid}-{mqttUuid}-{ts}`); its `mqttUuid` half must be stable across restarts, or every
   * restart presents itself to the broker as a new client, so it defaults deterministically from the user
   * id (see {@link SolixMqttOptions.mqttUuid}) rather than a fresh random per instance.
   */
  constructor(opts: SolixMqttOptions) {
    super();
    this.appName = opts.mqttInfo.app_name ?? "anker_power";
    this.userId = opts.userId ?? opts.mqttInfo.user_id;
    this.armIntervalMs = opts.armIntervalMs ?? 25_000;
    this.siteId = opts.siteId;
    this.logger = opts.logger;
    const uid = this.userId ?? "anonymous";
    this.appClientId =
      opts.appClientId ??
      buildAppShapedClientId({
        appName: this.appName,
        uid,
        mqttUuid: opts.mqttUuid ?? mqttUuidFrom(`anker-solix-mqtt:${uid}`),
      });
    this.transport = new SecureMqtt({
      credentials: opts.mqttInfo,
      clientId: opts.clientId ?? opts.mqttInfo.thing_name,
      reconnectPeriod: 5000,
      logger: opts.logger,
    });
    this.transport.on("error", (e) => this.emit("error", e));
    this.transport.on("message", (msg: { topic?: string; raw: unknown }) => this.onMessage(msg));
  }

  /**
   * Connect, subscribe to the device's telemetry (+ command-reply) topics, ARM realtime reporting, and
   * start the re-arm/heartbeat timer so telemetry keeps flowing without the app. Idempotent per device.
   *
   * Subscribes ONLY to what the device sends — `param_info` plus the device and account command-reply
   * channels — never the `…/req` channels, which are the app→device request side this arms on, and would
   * echo its own publishes back.
   *
   * Throws when `param_info` was not granted. A scope-denied filter comes back as SUBACK_FAILURE rather
   * than an error (see `SecureMqtt.subscribe`), so an unusable subscription otherwise looks like
   * success: the call would resolve and arm on every interval while no reading ever arrives.
   *
   * The re-arm timer is unreffed, so a caller that watches and returns can still exit.
   */
  async watch(device: SolixMqttDevice): Promise<void> {
    await this.transport.connect();
    const topics = solixDeviceTopics(this.appName, device.product_code, device.device_sn);
    const granted = await this.transport.subscribe([
      topics.paramInfo,
      topics.cmdRes,
      ...(this.userId ? [solixUserTopics(this.appName, this.userId).cmdRes] : []),
    ]);
    if (!granted.includes(topics.paramInfo)) {
      const scope = this.appName;
      throw new Error(
        `watch ${device.device_sn}: telemetry topic "${topics.paramInfo}" denied on credential scope ` +
          `"${scope}" — the subscription would arm but never deliver a reading`,
      );
    }
    this.watched.set(device.device_sn, device);
    if (this.armIntervalMs > 0) {
      await this.armAll();
      if (!this.armTimer) {
        this.armTimer = setInterval(() => void this.armAll(), this.armIntervalMs);
        this.armTimer.unref?.();
      }
    }
  }

  /** Tear down the connection and stop the re-arm timer. */
  async close(): Promise<void> {
    if (this.armTimer) {
      clearInterval(this.armTimer);
      this.armTimer = undefined;
    }
    this.watched.clear();
    await this.transport.disconnect();
  }

  /**
   * Re-arm every watched device and send the site heartbeat. The device only pushes `param_info` while
   * a client keeps requesting it — this replays the app's `requestDeviceInfo` (cmd 17) + `power_site`
   * heartbeat (cmd 10); the request frames are reproduced byte-for-byte by {@link buildFf09Request}
   * (checksum-verified against captured frames in its spec). Best-effort: a publish failure is emitted,
   * not thrown, so one bad device doesn't stop the rest or kill the timer.
   */
  private async armAll(): Promise<void> {
    for (const device of this.watched.values()) {
      try {
        await this.arm(device);
      } catch (e) {
        this.emit("error", e);
      }
    }
    if (this.userId) {
      try {
        await this.transport.publish(solixUserTopics(this.appName, this.userId).powerSite, this.heartbeatEnvelope(), {
          qos: 1,
        });
      } catch (e) {
        this.emit("error", e);
      }
    }
  }

  /** Publish the device-info arming request (both the "info" and "realtime" ff09 variants the app sends). */
  private async arm(device: SolixMqttDevice): Promise<void> {
    const topic = solixDeviceTopics(this.appName, device.product_code, device.device_sn).req;
    for (const variant of ["info", "realtime"] as const) {
      const body = this.commandEnvelope(
        device,
        buildFf09Request(variant),
        variant === "info" ? { encoding_type: 2 } : {},
      );
      await this.transport.publish(topic, body, { qos: 1 });
    }
    this.logger?.debug?.(`[solix] armed ${device.device_sn} (param_info reporting requested)`);
  }

  /** The common `head` fields for every cmd envelope; callers add `cmd` + the per-message variable bits. */
  private makeHead(cmd: number, extra: Record<string, unknown>): Record<string, unknown> {
    return {
      version: "1.0.0.1",
      client_id: this.appClientId,
      timestamp: Math.floor(Date.now() / 1000),
      cmd_status: 2,
      sign_code: 1,
      cmd,
      ...extra,
    };
  }

  /**
   * Build the `{head, payload}` cmd-17 (requestDeviceInfo) envelope carrying a base64 ff09 request.
   * `account_id` is omitted when the user id is unknown: a live broker cannot tell an empty placeholder
   * from a real value, so sending `""` would claim an account this client does not have.
   */
  private commandEnvelope(device: SolixMqttDevice, frame: Buffer, extra: Record<string, unknown>): string {
    this.seq += 1;
    return JSON.stringify({
      head: this.makeHead(17, {
        sess_id: genId(),
        msg_seq: this.seq,
        seed: genId(),
        device_pn: device.product_code,
        device_sn: device.device_sn,
      }),
      payload: JSON.stringify({
        device_sn: device.device_sn,
        ...(this.userId ? { account_id: this.userId } : {}),
        data: frame.toString("base64"),
        ...extra,
      }),
    });
  }

  /**
   * The `power_site` heartbeat (cmd 10) envelope the app sends on a timer to keep the session alive.
   * `site_id` is omitted when unknown, for the same reason `account_id` is in {@link commandEnvelope}.
   */
  private heartbeatEnvelope(): string {
    return JSON.stringify({
      head: this.makeHead(10, { sess_id: "1", msg_seq: 1, seed: "1" }),
      payload: JSON.stringify({ user_id: this.userId ?? "", ...(this.siteId ? { site_id: this.siteId } : {}) }),
    });
  }

  /**
   * Decode one inbound MQTT message envelope and emit a `reading` if it carries an ff09 param frame. The
   * product code and the fallback serial come from the topic (`dt/{app}/{pn}/{sn}/param_info`); the frame's
   * own `a2` field wins for the serial when it carries one.
   */
  private onMessage(msg: { topic?: string; raw: unknown }): void {
    const topic = msg.topic ?? "";
    const buf = extractFf09Payload(msg.raw);
    if (!buf) return;
    const frame = decodeSolixParamFrame(buf);
    if (!frame) return;
    const parts = topic.split("/");
    const reading: SolixReading = {
      deviceSn: frame.deviceSn ?? parts[3] ?? "",
      productCode: parts[2] ?? "",
      topic,
      frame,
      values: solixReadings(frame),
    };
    this.emit("reading", reading);
  }
}

/**
 * Pull the ff09 binary frame out of a received message. Solix telemetry arrives as a `{head, payload}`
 * envelope whose `payload` is a JSON string carrying base64 `data` (or `trans`); `SecureMqtt`
 * has already JSON-parsed the outer envelope. Returns the decoded frame bytes, or `null`.
 */
export function extractFf09Payload(raw: unknown): Buffer | null {
  if (Buffer.isBuffer(raw)) return raw;
  if (!raw || typeof raw !== "object") return null;
  const env = raw as { payload?: unknown; data?: unknown };
  let payload: unknown = env.payload;
  if (typeof payload === "string") {
    try {
      payload = JSON.parse(payload);
    } catch {
      return null;
    }
  }
  const p = payload as { data?: unknown; trans?: unknown } | undefined;
  const data = p?.data ?? p?.trans ?? env.data;
  if (typeof data !== "string") return null;
  const buf = Buffer.from(data, "base64");
  return buf.length ? buf : null;
}

/**
 * Build the ff09 request frame the app base64-encodes into a `requestDeviceInfo` (cmd 17) command's
 * `data`. Captured live from the Anker app — request-type tag `a1`=0x22; the `realtime` variant adds
 * `a2`/`a3` params (this is the one that keeps `param_info` reporting flowing), while `info` is the bare
 * device-info fetch. Frame:
 *   `ff09 | len(u16 LE, TOTAL bytes incl. ff09+len+xor) | 5-byte header | a1 01 22
 *    [| a2 02 01 01 | a3 03 02 2c 01] | fe … <ts32 LE> | xor`
 * `fe` carries a fresh unix-timestamp nonce; the trailing byte is XOR of every preceding byte (the same
 * checksum the meter's telemetry frames use — verified to reproduce the captured frames exactly).
 */
export function buildFf09Request(variant: "info" | "realtime", atUnixSec?: number): Buffer {
  const ts = Buffer.alloc(4);
  ts.writeUInt32LE((atUnixSec ?? Math.floor(Date.now() / 1000)) >>> 0);
  const body =
    variant === "info"
      ? Buffer.concat([Buffer.from([0x03, 0x00, 0x0f, 0x00, 0x40, 0xa1, 0x01, 0x22, 0xfe, 0x04]), ts])
      : Buffer.concat([
          Buffer.from([
            0x03, 0x00, 0x0f, 0x00, 0x57, 0xa1, 0x01, 0x22, 0xa2, 0x02, 0x01, 0x01, 0xa3, 0x03, 0x02, 0x2c, 0x01, 0xfe,
            0x05, 0x03,
          ]),
          ts,
        ]);
  const frame = Buffer.alloc(body.length + 5);
  frame[0] = 0xff;
  frame[1] = 0x09;
  frame.writeUInt16LE(frame.length, 2);
  body.copy(frame, 4);
  let xor = 0;
  for (let i = 0; i < frame.length - 1; i++) xor ^= frame[i]!;
  frame[frame.length - 1] = xor;
  return frame;
}
