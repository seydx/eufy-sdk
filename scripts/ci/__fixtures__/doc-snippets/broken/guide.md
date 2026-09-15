# A guide with the two bugs this checker was built for

Both of these shipped in `docs/vacuums.md` and a reviewer found them, not CI.

```ts
const clean = dev.vacuumClean?.();
await dev.suction?.()?.setLevel?.(2);
const scenes = clean?.scenes;
const first = scenes?.find((s: { valid: boolean }) => s.valid);
void first;
```
