# Realtime transports

A device's realtime path follows its ecosystem. What differs per device is the realtime transport it
speaks — but **you never select it, and you never open it by hand.** The SDK manages connectivity for
you (see [Connectivity & battery](/connectivity)); this table is a reference for _which_ transport
carries each class, not a set of calls to make:

| Device class                        | Realtime transport     | Carries                            |
| ----------------------------------- | ---------------------- | ---------------------------------- |
| HomeBase / station                  | **p2p**                | device-state + semantic events     |
| Camera / doorbell                   | **p2p**                | events, faces, live video          |
| Entry / motion sensor, keypad, lock | **p2p** (via HomeBase) | open/close + state (poll fallback) |
| Robot vacuum, light, plug, display  | **smqtt**              | appliance DP-state                 |

- **P2P** — the realtime channel for the security ecosystem (peer-to-peer over UDP), not MQTT. One
  session per HomeBase; emits device-state events, pulls the face roster, and carries live video (see
  [Live media](/live-media)).
- **Secure MQTT (`smqtt`)** — Anker's mTLS broker; drives eufy_mega / eufy_home appliances and carries
  the cloud DP-state shadow for security devices' settings.
- **FCM push** — orthogonal to the above; the always-on event + thumbnail channel for any device
  class, with v6 AI enrichment. Events reach you over push regardless of P2P.

## Connectivity is automatic

Connectivity is transport-agnostic and SDK-owned. A successful `login()` brings up the event channels
(push + secure MQTT) automatically; P2P to a camera opens on demand the moment a command, live stream,
or doorbell ring needs it, and detaches when idle so battery cameras can sleep. Just log in, read
devices, and send actions:

```ts
await eufy.login(); // realtime comes up on its own
eufy.on("motion", (e) => console.log("motion on", e.deviceSn));
const dev = await eufy.getDevice(sn);
await dev.camera?.()?.snapshotLive?.(); // explicit fresh capture; opens P2P on demand
```

Stored snapshots follow a separate path: qualifying push thumbnails are acquired eagerly, and
`snapshotStored()` later reads only retained memory without opening P2P or making a network request.

How the lifecycle, battery savings, the opt-in event pre-warm and the read cache work — and the knobs
to tune them — is the subject of the next page.

Next: [Connectivity & battery](/connectivity) · [Live media](/live-media).
