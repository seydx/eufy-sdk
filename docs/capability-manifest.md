# Describing a device

A host that renders devices generically needs to know what a device exposes **before** it knows which
device it has. `dev.describe()` answers that as data: every read the device installed, every action it
can be asked to perform, and every event each capability emits.

```ts
const dev = await eufy.getDevice(sn);
const manifest = dev.describe();
```

Nothing in the loop below names a capability, a property or a device model — which is the point. A
capability added to the SDK appears in it with no change to your code.

```ts
for (const cap of manifest.details) {
  for (const r of cap.reads) console.log(cap.accessor, r.accessor, r.kind, r.unit ?? "");
  for (const a of cap.actions) console.log(cap.accessor, a.name, a.form, a.args);
}
```

See `examples/10-describe-device.ts` for the runnable version, which also reads the values back.

## What you get

<!-- typecheck: skip — a sketch of the returned SHAPE, not a statement: a bare object literal with elided fields -->

```ts
{
  sn, codec, source,
  name: "Dining room",             // what the user named it; the model's name when unnamed
  model: "T8410",                  // T-code, when the record states one
  modelName: "Indoor Cam Pan & Tilt",
  bound: true,                     // false until the device is wired to a live client
  capabilities: ["camera", "motion", "battery", …],
  details: [
    {
      capability: "battery",
      accessor: "battery",         // dev.battery?.()
      reads: [
        { accessor: "level", property: "battery", type: "number",
          kind: "percent", unit: "%", writable: false, description: "…" },
      ],
      actions: [
        { name: "setWorkingMode", form: "stateful", reflects: "workingMode",
          args: [{ name: "workingMode", kind: "enum", values: [0, 1, 2] }], description: "…" },
      ],
      undescribedActions: [],
      events: ["batteryAlert"],
    },
  ],
}
```

`accessor` is how you get back to the live object: `dev[cap.accessor]()` returns the capability object,
and `r.accessor` is the getter on it. `property` is the same value's name in the flat
[`getProperty`](/devices) namespace.

`kind` is what the value **means** — a percentage, a temperature, an instant, one of a fixed set. It is
the field a control surface is built from; [what a reading means](/value-kinds) covers the vocabulary
and the reason a `type` alone is not enough. A read with a fixed domain also carries `values` and
`labels`, so you can render a picker without a lookup table of your own.

## It describes the device in front of you

The manifest lists what **this** device installed, not what the capability could offer in general. Two
cameras of different generations describe different reads, and an entry sensor that reports only a
battery level describes exactly one battery read — not the five a battery-powered camera has.

The same holds for writes. `writable` on a read, and an action being listed at all, both mean a caller
can actually perform it here: a control the device gave no evidence for, and one whose behaviour is not
confirmed on real hardware, are absent rather than described. So everything in the manifest is safe to
offer — nothing in it is a control that would silently do nothing.

An action's `form` says whether there is state to show:

- `stateful` — it changes a value you can read back, and `reflects` names that read. This is what a
  switch or a slider binds to.
- `momentary` — it does something once and there is nothing to display afterwards.

`undescribedActions` are installed and callable, but nothing is published about what they take, so they
cannot be offered automatically. They are listed rather than hidden so the gap is visible instead of
looking like the method is missing.

An action's `args` say what it accepts. **Absent `args` means the signature is not stated, not that the
action takes nothing** — a method that owns its own signature (a media call, a multi-part setting) is
described so you know it exists, but its arguments are not something the SDK can state generically.
Auto-generate a control only for an action that states its arguments; reach for the rest from code that
knows the method.

## Shape only, and two methods for two jobs

`describe()` carries **no values**. It reads none while building — no getter is invoked — so calling it
is free of device traffic, and the values come from the capability getters it names:

```ts
const battery = dev.battery?.();
for (const r of manifest.details.find((d) => d.accessor === "battery")?.reads ?? []) {
  console.log(r.accessor, (battery as Record<string, unknown> | undefined)?.[r.accessor], r.unit ?? "");
}
```

It is deliberately separate from `toJSON()`, which is the value snapshot and fires on every implicit
`JSON.stringify` — an event payload, a log line — where the shape is not wanted. The manifest itself is
plain JSON: hand it over a socket unchanged.

## Before the device is bound

A device obtained from a live client is bound. A model object built without one has no bound capability
objects to describe, so `bound` is `false` and `details` is empty while `capabilities` still lists what
the device is. That distinction exists so "this device exposes nothing" can never be confused with "ask
again once it is connected".

## Mapping it to your own surface

The vocabulary is intentionally the SDK's own, not any one platform's: `kind`, `reads`, `actions`,
`events`. Each host writes one small table from that vocabulary to its own — a value class, a control
type, a unit — and after that, a capability added here appears there with no release of your own. What
the SDK will not do is pick your control type for you; the meaning is the part we can state truthfully,
the presentation is yours.
