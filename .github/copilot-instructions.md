# Copilot instructions

**Read [AGENTS.md](../AGENTS.md) first — it is the code practice for this repository, and it is what
a review here is measured against.** This file exists only because Copilot does not load `AGENTS.md`
on its own; everything normative lives there, not here.

When reviewing a pull request, weight these above generic style feedback. Each one fails the build or
ships a bug that looks like success:

- **Need and scope first.** Before the code: does the pull request name who hits the problem today, is
  it the only open or merged fix for it, and does it do one thing? A missing need or a duplicate is the
  finding; say so before any line comment.
- **Layer direction.** `model/` must never import `transport/` (or a wire library: `mqtt`,
  `protobufjs`), and `transport/` must never import `model/`. A shared need becomes an
  interface in `core/contracts.ts`, injected by `client/` — never a relaxed import or a wire constant
  hoisted into `core/`. CI greps both directions.
- **Guessed wires.** A write path that has not been confirmed on real hardware must throw, not send a
  frame. Some writes are fire-and-forget, so a guess is indistinguishable from success. Likewise, a
  typed getter must not be backed by a parameter id no device has been seen to report.
- **Real device data.** Serials (`T####…`), the P2P device id, account and user ids, device names,
  IP addresses and key material are credentials or PII and must never appear — in code, specs,
  fixtures, docs or commit messages. Flag any concrete-looking identifier.
- **Consumer-agnostic surface.** Nothing in `src/`, `docs/` or `examples/` may name a specific host
  or its stack. Say "caller" or "host". Call it the SDK.
- **Dependencies.** Three runtime deps, deliberately. A new `dependencies` entry needs a real
  justification in the PR; a `node:*` builtin or an inlined one-liner is the expected answer.
- **Comments.** JSDoc above the declaration, no narration inside function bodies. A body comment
  means the JSDoc is incomplete.
- **Capability shape.** One `members` table per module, everything derived from it. A second table
  describing the same feature, or a `switch` on a capability name outside its own module, is the
  defect to catch.
- **Shipped source cites its peers.** No `.md` paths or `docs/` references in `src/` — it ships in
  `dist/`, where those paths do not exist.

Do not suggest reformatting: Prettier owns formatting and CI checks it. Do not propose adding a
linter, a test framework, or a build tool — those choices are settled in `AGENTS.md`.
