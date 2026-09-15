# Smart lights

The eufy **Life** smart-lighting line — e.g. the T8L02 "Permanent Outdoor Lights" — is driven through
the `smartLight` capability. Like every capability it's resolved dynamically, so any light on this line
exposes the same fluent API — on/off and brightness work across the line, while `setColor` and
`setEffect` are currently limited to one model (see [Limitations](#limitations)).

```ts
const dev = await eufy.getDevice(sn);
const light = dev.smartLight?.(); // present only on a eufy_life light, bound to a live client
```

The accessor returns `undefined` on a device without the capability, so guard it (`dev.smartLight?.()?…`)
or assert once up front.

A light is not a camera: `dev.camera`, `dev.light` and `dev.ptz` are **absent** on this line, and
`dev.capabilities` lists only what it has. See
[Devices & capabilities](/devices#fluent-typed-actions).

## On / off / brightness

```ts
await light.on();
await light.off();
await light.setBrightness(80); // 0–100
```

## Custom colour

On a T8L02 with reported segment-count evidence, select one plain RGB colour independently from the
gallery-effect catalogue:

```ts
await light.setColor?.({ red: 255, green: 96, blue: 0 });
```

Each channel must be an integer from 0 through 255. Invalid values reject rather than being rounded or
clamped, and the SDK sends nothing when the model or current segment evidence is unsupported.

`setColor` changes colour only. It preserves the configured `brightness`; call `setBrightness`
separately when you intend to change both. It also uses a different device command from
`setEffect(lightId)`: a plain custom colour is not a gallery entry, and fully custom DIY animations are
not supported by this method.

Completion means the secure-MQTT transport accepted the publish. It does not prove the physical light
has converged, and there is deliberately no current-colour getter: the device's current reports do not
identify authoritative RGB state.

## Effects

An effect is chosen by its **catalogue id**. The catalogue is account/region-scoped (not tied to one
device), so you browse it with a standalone helper, passing the session's HTTP client from `eufy.api`:

```ts
import { listLightEffects } from "@mega-yfue/eufy-sdk";

const effects = await listLightEffects(eufy.api);
// → [{ lightId: 10474, name: "Presidents Day", colors: "ff0000|…", buildable: true }, …]

const usable = effects.filter((e) => e.buildable);
await light.setEffect(usable[0].lightId);
```

`listLightEffects(eufy.api)` returns one entry per catalogue effect across the app's category tabs
(favorite / daily / holiday / nature / moods / culture). Each carries:

- **`lightId`** — the id you pass to `setEffect`.
- **`name`** / **`colors`** — display name and a `"RRGGBB|…"` preview swatch, when the catalogue
  provides them.
- **`buildable`** — whether `setEffect` can drive that entry. A `false` here means the effect can't be
  applied yet (see [Limitations](#limitations)); grey it out in a picker.

`setEffect(lightId)` fetches that effect's definition itself and applies it (plus the effect's own
brightness, if it carries one) — you only pass the id.

`listLightEffects` scans a default id range; pass `idRange` or `ids` to widen or target specific
entries:

```ts
await listLightEffects(eufy.api, { idRange: [10001, 12000] });
await listLightEffects(eufy.api, { ids: [10474, 10550] });
```

### AI ambient scenes

The AI-generated ambient scenes (e.g. "Enchanting Starry Night", "Moonlit Serenity") are a **separate**
resource — they come back as names only, with no `lightId`, so they can't currently be applied through
`setEffect`. List them for display:

```ts
import { listAiSceneRecommendations } from "@mega-yfue/eufy-sdk";

const scenes = await listAiSceneRecommendations(eufy.api);
// → ["Enchanting Starry Night", "Moonlit Serenity", …]
```

## Reading state

Typed getters on the capability, each `undefined` until the device has reported that field:

```ts
light.power; // boolean — is it on
light.brightness; // number  — configured level 0–100
light.effectId; // number  — the selected catalogue effect
light.cloudEffectId; // number  — the effect actually RUNNING; 0 when off
light.colorGradient; // boolean — colour-gradient mixing
light.lightLength; // number  — addressable segments
```

`brightness` is the **configured** level and persists across `off` — pair it with `power` rather than
treating `0` as off. `effectId` vs `cloudEffectId` distinguishes "selected" from "running": after
`off()` the selection stays and `cloudEffectId` goes to `0`.

The same snapshot arrives as an event on every change. Every field is optional — a report carries only
what the device sent, and an absent field is silence about it, not a change to it:

```ts
eufy.on("smartLightState", (e) => console.log(e.deviceSn, e.power, e.brightness));
```

State on this line is **reported, not polled**: it arrives when the device announces a change. The SDK
requests a snapshot as soon as a light's realtime channel is up and `getDevice` waits for the answer,
so the getters are populated by the time you get the device. They remain optional — a light that never
answers leaves them `undefined` rather than blocking the lookup — and `smartLightState` is what tells
you the moment state changes. To re-read on demand:

```ts
await light.refreshState(); // resolves once asked; the values land via the event
```

`refreshState()` resolves when the request is sent, not when the answer arrives — read the getters (or
listen for `smartLightState`) afterwards.

::: tip
A `Device` you already hold is updated in place, so re-reading `light.power` after an event reflects the
new value without fetching the device again.
:::

## Limitations

- **Some effects aren't buildable yet.** A few effects (certain nature/moods scenes) use a parameter
  shape that isn't fully mapped; `listLightEffects` marks them `buildable: false` and `setEffect`
  rejects them without sending anything to the light. This shrinks as coverage grows.
- **`setEffect` is confirmed on one model so far.** Every light in this line offers effects; what's
  limited is which models the SDK has confirmed it drives correctly. Only the Permanent Outdoor
  Lights E22 has been verified on real hardware, so on the others `setEffect` rejects without sending
  anything rather than apply something unverified. On/off and brightness work across the line, and
  the list widens as models are verified. Note `buildable` describes the effect, not the device — on
  a model outside that list every entry still reports `buildable: true` and `setEffect` rejects
  regardless.
- **`setColor` is confirmed only on T8L02.** It also requires a current reported `lightLength`, because
  the frame addresses every segment explicitly. Other models or missing/malformed segment evidence
  reject before publication; the SDK does not guess a family-wide length or generalize this frame to
  another T8L0x model.
- **Current RGB is not reported.** A successful `setColor` is a publication acknowledgement, not a
  readable state update, so no `color` getter or synthetic event is exposed.
- **AI scenes are list-only** (see above) — no id to apply.
