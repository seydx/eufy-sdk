#!/usr/bin/env bash
# Capability ownership (the rule that a capability's semantics live in its own module).
#
# A capability owns its wire ids, its polarity, its enum domains and its member names, and everything
# else is DERIVED from that one `members` table. `src/model/device.ts` and `src/client/` are the two
# places that see every capability at once, so they are the two places the rule can quietly break: one
# `if (caps.has("camera"))` in the facade, and a capability's semantics have a second home that nobody
# reviewing that capability will ever look at.
#
# Until now that was convention, enforced only by review — unlike the decorrelation rule beside it,
# which is grepped. The generic property announcement is what makes the gap worth closing: the whole
# point of deriving it from the members table is that the facade receives property NAMES and emits,
# adding no branch on a capability, so a future change that reaches for one should fail here rather
# than in review.
#
# Two checks, both on CODE lines only — a JSDoc example must be able to show `dev.has("camera")`, which
# is the public API this layer exists to offer.
#
#   1. A capability DECISION: a capability id as a string literal on a line that also reads capability
#      vocabulary (`capabilities`, `caps`, `.has(`). This is the `switch`/`if` on a capability name the
#      coding standards forbid outside a capability module. Matching the CONTEXT rather than the bare
#      word is what makes the check usable: `camera`, `light`, `lock` and `battery` are also a codec
#      name and a power tier in these layers, and a bare-literal grep would flag the codec table in
#      device-registry.ts and the `PowerTier` default while saying nothing about a real decision.
#   2. A capability ACCESSOR called: `dev.camera()`, `dev.vacuumClean()`. Reaching into one bound
#      capability object from the facade is the same violation arriving by another road — it needs no
#      capability id in a string, so check 1 cannot see it.
#
# The member-identifier half of the rule is expressed as check 2 rather than as a list of member keys.
# Member keys are ordinary words — `open`, `level`, `enabled`, `volume`, `active` — so a literal list
# would flag prose and ordinary local variables everywhere and be switched off within a week; the
# accessor is the reachable form of the same reach, and it is greppable.
#
# Single source of truth: package.json `guard:capability-ownership` (folded into `npm run verify`) runs
# this; CI runs verify.
set -uo pipefail

fail=0

for path in src/model/device.ts src/client; do
  if [ ! -e "$path" ]; then
    echo "::error::$path not found — run this from the package root"
    exit 1
  fi
done

# Every `Capability` id, read off the union in src/model/types.ts rather than restated — a capability
# added there is covered here with no edit, which is the only way a hardcoded list stays true.
caps=$(sed -n '/^export type Capability =$/,/;$/p' src/model/types.ts |
  grep -oE '"[a-z_]+"' | tr -d '"' | paste -sd '|')
if [ -z "$caps" ]; then
  echo "::error::could not read the Capability union from src/model/types.ts — this guard would pass while checking nothing"
  exit 1
fi

# The camelCased accessor each capability id installs (`vacuum_clean` -> `vacuumClean`), which is how a
# capability object is reached on a Device.
accessors=$(echo "$caps" | tr '|' '\n' |
  sed -E 's/_([a-z])/\U\1/g' | paste -sd '|')

# The lines a reviewer means by "the code": full-line comments dropped, trailing `//` comments cut.
# Neither target file puts `//` inside a string literal, so cutting at the first one is safe here.
code() {
  grep -rn --include='*.ts' --exclude-dir='__tests__' '' src/model/device.ts src/client |
    grep -vE '^[^:]+:[0-9]+:[[:space:]]*(\*|//|/\*)' |
    sed -E 's_[[:space:]]//.*$__'
}

decisions=$(code | grep -E "\"($caps)\"" | grep -E '(capabilit|caps|\.has\()' || true)
if [ -n "$decisions" ]; then
  echo "::error::device.ts / client/ branches on a capability name — a capability's semantics belong in its own module, and these layers are derived from the barrel projections:"
  echo "$decisions"
  fail=1
fi

reaches=$(code | grep -E "\.($accessors)\??\(\)" || true)
if [ -n "$reaches" ]; then
  echo "::error::device.ts / client/ calls a capability accessor — the facade fans out over the barrel projections and never names one capability:"
  echo "$reaches"
  fail=1
fi

exit "$fail"
