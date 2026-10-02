/**
 * Example 10 — ask a device what it exposes, and render it without knowing any capability.
 *
 * `dev.describe()` answers with the device's shape as data: every read it installed (with what the
 * value MEANS, not just how it is stored), every action a caller can offer (with what it accepts), and
 * every event each capability emits. Nothing here names a capability, a property or a param — the loop
 * below is the whole mapping a host needs, and a capability added to the SDK shows up in it with no
 * change to this file.
 *
 * The manifest carries SHAPE only. Values come from the capability getters it names, which is what the
 * second loop does — reaching each read back through the accessor the manifest published.
 *
 *   EUFY_EMAIL=… EUFY_PASSWORD=… node examples/10-describe-device.ts <serial>
 *
 * Requires `npm run build` first.
 */
import { loginClient } from "./_client.ts";
import type { ReadDescriptor } from "../dist/index.js";

/** A reading's unit suffix — the manifest ships it, so nothing is looked up per property. */
const suffix = (r: ReadDescriptor): string => (r.unit ? ` ${r.unit}` : "");

async function main(): Promise<void> {
  const sn = process.argv[2];
  if (!sn) throw new Error("usage: node examples/10-describe-device.ts <serial>");

  const eufy = await loginClient();
  const dev = await eufy.getDevice(sn);

  const manifest = dev.describe();
  const product = [manifest.modelName, manifest.model].filter(Boolean).join(" ");
  console.log(`${manifest.name} (${product}) — ${manifest.codec}, by ${manifest.source}, bound=${manifest.bound}`);
  console.log(`capabilities: ${manifest.capabilities.join(", ")}\n`);

  for (const cap of manifest.details) {
    console.log(cap.accessor === undefined ? cap.capability : `${cap.accessor}()`);

    for (const r of cap.reads) {
      // `kind` is what the value means (percent, celsius, timestamp, enum …) — that plus `values`/
      // `labels` is enough to pick a control, with no table of property names.
      const domain = r.values ? ` one of [${r.values.join(", ")}]` : "";
      console.log(`  read  ${r.accessor}: ${r.kind ?? r.type}${suffix(r)}${r.writable ? " (writable)" : ""}${domain}`);
    }

    for (const a of cap.actions) {
      // `stateful` means the action changes a value you can read back — `reflects` names that read, so
      // a control can show its own position. `momentary` has no state to show.
      //
      // An EMPTY `args` means the method takes nothing — a plain button. No `args` at all means the
      // signature is not STATED, which is different: offer those from your own code rather than
      // generating a control for them. An argument's own `values` is what it ACCEPTS, which can be
      // narrower than the `values` on the read it reflects (what the device can report).
      const args = a.args
        ? a.args
            .map((arg) => {
              const range = arg.min !== undefined && arg.max !== undefined ? ` ${arg.min}..${arg.max}` : "";
              const domain = arg.values ? ` [${arg.values.join(", ")}]` : "";
              return `${arg.name}: ${arg.kind}${range}${domain}${arg.optional ? "?" : ""}`;
            })
            .join(", ")
        : "…";
      const reflects = a.reflects ? ` → reflects ${a.reflects}` : "";
      console.log(`  call  ${a.name}(${args}) [${a.form}]${reflects}`);
    }

    // Callable, but with nothing said about what they take — usable if you know the SDK, not
    // auto-offerable. Listed so the gap is visible rather than looking like the method is absent.
    if (cap.undescribedActions.length) console.log(`  also  ${cap.undescribedActions.join(", ")} (undescribed)`);
    if (cap.events.length) console.log(`  emits ${cap.events.join(", ")}`);
  }

  // Shape → values: reach each read back through the accessor the manifest named. Still no capability
  // spelled out anywhere.
  console.log("\ncurrent readings");
  const accessors = dev as unknown as Record<string, (() => Record<string, unknown> | undefined) | undefined>;
  for (const cap of manifest.details) {
    // A capability whose whole surface is inbound events names no accessor: there are no readings to
    // reach, only the events printed above.
    if (cap.accessor === undefined) continue;
    const obj = accessors[cap.accessor]?.();
    if (!obj) continue;
    for (const r of cap.reads) {
      const value = obj[r.accessor];
      if (value !== undefined) console.log(`  ${cap.accessor}.${r.accessor} = ${String(value)}${suffix(r)}`);
    }
  }

  await eufy.disconnect();
}

main().catch((e: unknown) => {
  console.error("FATAL", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
