# Product roadmap

Portcove release stages are cumulative product-maturity contracts. They are
not frozen port lists and have no catalog-count requirement. The catalog may
grow continuously; each port carries its own channel, platform, and
qualification state without automatically becoming a global V1 blocker.

Current priority, horizon, target release, blockers, and detailed scope live in
the [Portcove Roadmap](https://github.com/users/boburning/projects/1).

## Alpha 1 — Trustworthy technical alpha

Close the core install, source-identity, launch, backup, provider, executable,
and permission trust blockers required for controlled technical testing.

## Alpha 2 — Onboarding and storage alpha

Ship structured supported-source inspection, actual-versus-expected hash
visibility, Source Inbox with safe copy/move import and discovery, persisted
library selection, per-game destinations and safe relocation, and official
source-tool links with persisted manual paths.

## Alpha 3 — Integration and scale alpha

Close stale asynchronous behavior, machine-contract and transport gaps,
provider/data-access scaling problems, controller performance issues, and
internal boundary work justified by proven transaction seams. Exact historical
release pin/follow-latest semantics may land here only after the required Alpha
2 onboarding work unless priority changes deliberately.

## Beta 1 — V1 feature-complete beta

All required V1 capabilities are present. Feature scope freezes except for
blocker-driven changes. The initial Steam Deck baseline qualification target is
Beta 1; qualification determines whether ordinary Linux packaging is sufficient
rather than assuming a separate build.

## Beta 2 — Qualification beta

Physical platform, controller, representative-port, installer, migration,
backup/restore, and user-experience qualification is substantially complete.

## RC — Release candidate

Exact release artifacts, upgrade paths, packaging, signing requirements for
claimed platforms, and the release rehearsal pass with no known release blocker.

## V1

Ordinary users can safely use the declared V1 platforms and understand every
port's support state. All cumulative required gates are complete. Representative
canary ports and platform evidence may be release gates; the total number of
catalog entries is never a V1 gate.

Signed OTA/self-update support is visible in the product pipeline but initially
targets Post-V1. Its target may move after Portcove has a signed updater
contract, artifact identity, signing and notarization decisions, failed-update
recovery, and rollback.
