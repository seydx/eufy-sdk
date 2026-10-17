/**
 * Garage/lock broker-INSTANCE discovery — reachability probing without ever publishing a command.
 *
 * `aiot-mqtt-{region}.anker.com` resolves through an AWS NLB (`…-nlb2-….elb.{region}.amazonaws.com`,
 * confirmed via `dig`) to one IP per AZ. The brokers behind those targets do NOT share subscribe/publish
 * routing state — a device's live session lives on exactly one target at a time. Landing on the wrong
 * one still completes the TLS CONNECT (same cert-trust chain everywhere) but denies SUBSCRIBE for that
 * device's topic (SUBACK return code 0x80). A granted SUBSCRIBE is a reliable proxy for "this instance
 * holds the device's session" — confirmed live: a real actuation only ever succeeded on an instance
 * that had already granted the SUBSCRIBE. That means we can find the right instance with SUBSCRIBE
 * alone — no PUBLISH is required to tell instances apart, so this module never sends one.
 */
import { loadMqtt } from "./engine.js";
import { resolve4 } from "node:dns/promises";
import { bareIpTlsOptions } from "./bare-ip-tls.js";

export interface BrokerCredentials {
  /** Broker hostname — used as the TLS SNI + cert-CN check target, NOT the socket connect target. */
  hostname: string;
  port?: number;
  certificate_pem: string;
  private_key: string;
  aws_root_ca1_pem: string;
}

export interface ProbeResult {
  ip: string;
  /** True iff SUBSCRIBE to the target topic was granted (qos 0/1/2). */
  granted: boolean;
  /** The SUBACK return code for the topic, the 0x80 deny code included. */
  grantedQos?: number;
  error?: string;
  ms: number;
}

/** Resolve current A records for the broker hostname. An NLB typically returns one IP per AZ, so this
 * is normally a short list (2-3), not the dozen the DNS-round-robin theory implied. */
export async function resolveBrokerIps(hostname: string): Promise<string[]> {
  try {
    return await resolve4(hostname);
  } catch {
    return [];
  }
}

/** Merge freshly-resolved DNS candidates with any previously-seen-good IPs, de-duplicated, DNS-first
 * (the DNS results are current; the extras are a fallback in case this resolver returns fewer targets
 * than have been seen historically). Pure/no I/O — kept separate so it's unit-testable. */
export function mergeCandidateIps(dnsIps: string[], extraIps: string[] = []): string[] {
  return Array.from(new Set([...dnsIps, ...extraIps]));
}

/** Rank probe results with granted instances first (stable order otherwise). Pure — unit-testable
 * without a real network connection. */
export function rankResults(results: ProbeResult[]): ProbeResult[] {
  return [...results].sort((a, b) => Number(b.granted) - Number(a.granted));
}

/**
 * Probe ONE candidate IP: connect, SUBSCRIBE to `topic`, record whether it was granted, then
 * disconnect. Never publishes anything — this function cannot actuate a device.
 *
 * The probe presents the account's client certificate, so it verifies the instance it dials: the TLS
 * options come from `./bare-ip-tls.ts`, which checks the presented certificate against
 * `creds.hostname` rather than the IP.
 */
export async function probeBrokerInstance(
  ip: string,
  creds: BrokerCredentials,
  opts: { clientId: string; topic: string; timeoutMs?: number },
): Promise<ProbeResult> {
  // Before the clock starts: the reported `ms` is a round trip to a broker, and a first caller that
  // also paid for loading the engine would otherwise record that module load as network latency.
  const mqtt = await loadMqtt();
  const start = Date.now();
  const timeoutMs = opts.timeoutMs ?? 8000;
  return await new Promise((resolvePromise) => {
    let settled = false;
    const finish = (r: Omit<ProbeResult, "ip" | "ms">) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        client.end(true);
      } catch {
        /* already closing */
      }
      resolvePromise({ ip, ms: Date.now() - start, ...r });
    };
    const client = mqtt.connect({
      host: ip,
      port: creds.port ?? 8883,
      protocol: "mqtts",
      ...bareIpTlsOptions({
        hostname: creds.hostname,
        cert: creds.certificate_pem,
        key: creds.private_key,
        ca: creds.aws_root_ca1_pem,
      }),
      clientId: opts.clientId,
      protocolVersion: 4,
      keepalive: 60,
      clean: true,
      reconnectPeriod: 0,
      connectTimeout: timeoutMs,
    });
    const timer = setTimeout(() => finish({ granted: false, error: "timeout" }), timeoutMs);
    client.on("connect", () => {
      client.subscribe(opts.topic, { qos: 1 }, (err, granted, packet) => {
        if (err) {
          const code = packet?.granted?.[0];
          return finish({
            granted: false,
            grantedQos: typeof code === "number" ? code : undefined,
            error: err.message,
          });
        }
        const g = granted?.[0];
        finish({ granted: !!g, grantedQos: g?.qos });
      });
    });
    client.on("error", (err) => finish({ granted: false, error: err.message }));
  });
}

export interface DiscoverOptions {
  /** Build a fresh client_id per attempt (the real client_id includes a connect timestamp). */
  clientIdFor: (ip: string) => string;
  /** The device's `.../res` topic to subscribe (never a `/req` topic — this module doesn't publish). */
  topic: string;
  /** Previously-seen-good IPs to probe alongside a fresh DNS resolution. */
  candidateIps?: string[];
  perAttemptTimeoutMs?: number;
  /** Stop at the first granted SUBSCRIBE instead of probing every candidate. */
  stopOnFirstGrant?: boolean;
}

/**
 * Probe every candidate instance (fresh DNS + any known extras), in sequence, SUBSCRIBE-only. Returns
 * every result, granted ones first, rather than only the first hit.
 */
export async function discoverReachableInstance(
  creds: BrokerCredentials,
  opts: DiscoverOptions,
): Promise<ProbeResult[]> {
  const dnsIps = await resolveBrokerIps(creds.hostname);
  const all = mergeCandidateIps(dnsIps, opts.candidateIps);
  const results: ProbeResult[] = [];
  for (const ip of all) {
    const r = await probeBrokerInstance(ip, creds, {
      clientId: opts.clientIdFor(ip),
      topic: opts.topic,
      timeoutMs: opts.perAttemptTimeoutMs,
    });
    results.push(r);
    if (r.granted && opts.stopOnFirstGrant) break;
  }
  return rankResults(results);
}
