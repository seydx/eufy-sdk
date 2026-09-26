<!--
Keep it dev-to-dev. What changed and why; skip the ceremony.
The rules this PR is reviewed against are in AGENTS.md.

BASE BRANCH: `main` only takes pull requests from `beta-X.Y.Z`. If this one targets main from
anywhere else, a check will block it — change the base with the dropdown above rather than opening
a new pull request; this one keeps its commits and its discussion. See CONTRIBUTING.md.
-->

## Who needs this

<!--
The user, issue or device run that hits the problem today, and what happens without this change.
A synthetic test alone is not a need. No answer here means the pull request is not ready.
-->

## What changed

## Why

## Evidence

<!--
For anything touching a wire: what grounds it? A real device that reported the parameter, an
observed exchange, a spec. "It matches the old client" is not evidence — see AGENTS.md.
Pure refactors, docs and tooling can say "n/a".
-->

## Verified how

- [ ] Searched open, closed and merged pull requests and issues for the same fix
- [ ] One point: nothing in this diff belongs to another change
- [ ] `npm run verify` is green locally
- [ ] Ran against a real device — which model, and what did it do?
- [ ] Added or updated specs (offline, synthetic fixtures)
- [ ] Docs updated, or n/a

## Unverified or deferred

<!--
Say it here rather than letting a reviewer find it. A write path that is byte-correct but never
driven on hardware is unverified — it must throw, not ship as working.
-->
