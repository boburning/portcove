# Portcove roadmap

Portcove helps players discover native game ports, understand the files they
need, prepare and play them, and keep a working setup without losing progress.
Desktop is the flagship experience; the public CLI is independently usable.
Rust Core owns game-management policy and recovery. React/Tauri and integrations
consume that authority rather than implement another installer.

Compatible catalog growth should not require proportional maintainer effort.
Deterministic tooling handles ordinary accepted additions, releases and
corrections. Agents investigate changed contracts and genuine exceptions.
Normal use stays local-first, without paid inference, mandatory accounts,
telemetry or redistribution of copyrighted game data.

## Start here

| Question                                     | Authoritative starting point                                                                                                                                                                                                                                                   |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| What comes next, and what has shipped?       | [Product Outcomes](https://github.com/users/boburning/projects/1/views/5), grouped by release and including completed outcomes. Issues contain current acceptance and evidence.                                                                                                |
| What prevents the next release?              | [Required for Beta](https://github.com/users/boburning/projects/1/views/6), then complete dependency-derived readiness below. [Required through 1.0](https://github.com/users/boburning/projects/1/views/10) shows later obligations.                                          |
| What are runners doing, and what comes next? | [In Progress](https://github.com/users/boburning/projects/1/views/3), [Next Queue](https://github.com/users/boburning/projects/1/views/2) and accepted reservations in [#793](https://github.com/boburning/portcove/issues/793). Status or Horizon alone is not a reservation. |
| Where is approved non-gating work?           | [Planned Additions](https://github.com/users/boburning/projects/1/views/9); these participate in the common execution queue.                                                                                                                                                   |
| What is happening with ports?                | Complete [Port Pipeline](https://github.com/users/boburning/projects/1/views/4) and [Active Port Work](https://github.com/users/boburning/projects/1/views/11). Catalog data establishes support.                                                                              |
| What requires the owner's decision?          | Concrete questions in the existing nightly report and [#793](https://github.com/boburning/portcove/issues/793), with effect and recommendation. Blocked or Deferred alone does not imply owner action.                                                                         |

Projects owns live planning fields and the port pipeline. Issues own executable
scope and evidence. Documents own stable contracts and dated history. These
views are navigation, not complete readiness proofs or another roadmap. Expand
native children for included components; collapsed row counts are not totals
of accepted scope or release readiness.

```sh
node scripts/roadmap.mjs next
node scripts/roadmap.mjs readiness --release "Public beta"
node scripts/roadmap.mjs readiness --release "1.0"
```

**Required** must finish for its target release. **Planned** is approved work
selected by Priority, Horizon, readiness and queue order; its classification
alone does not gate release. Genuine prerequisites still count, including
classification conflicts. Parentage, related links, display labels and queue
predecessors never manufacture blockers. Closed-child counts are child
completion, not effort estimates or proof of integrated delivery.

## Initial Public beta

The initial supported-platform promise is **Windows and ordinary Linux x86-64**,
qualified at the actual claimed scope. Required foundations include:

- [Design system #917](https://github.com/boburning/portcove/issues/917),
  [complete Desktop journeys #206](https://github.com/boburning/portcove/issues/206),
  [development agility #921](https://github.com/boburning/portcove/issues/921) and
  [core consolidation #925](https://github.com/boburning/portcove/issues/925).
- [Connected-folder discovery and selected setup #244](https://github.com/boburning/portcove/issues/244),
  [truthful operations #1168](https://github.com/boburning/portcove/issues/1168)
  and [useful user-prepared integrations #1169](https://github.com/boburning/portcove/issues/1169).
- [Repeatable onboarding #254](https://github.com/boburning/portcove/issues/254),
  [curated exact-byte acquisition #315](https://github.com/boburning/portcove/issues/315)
  where needed, and the **entire feasible frozen cohort** in
  [rollout #1422](https://github.com/boburning/portcove/issues/1422).
  Its accepted inventory fixes the boundary; later discoveries enter continuous
  intake. Pilots prove machinery, not rollout completion.
- [Account-free artwork #1155](https://github.com/boburning/portcove/issues/1155)
  and [shared choices/cache/fallback #208](https://github.com/boburning/portcove/issues/208).
  Missing artwork is a specific nonblocking exception, not a port gate.
- [Compatible delivery #246](https://github.com/boburning/portcove/issues/246),
  separately protected [production authority #534](https://github.com/boburning/portcove/issues/534),
  [Windows/Linux application updates #52](https://github.com/boburning/portcove/issues/52),
  applicable security, interruption, recovery and data preservation.

Completed source, lifecycle, definition and public-client foundations remain
credited. Reusable CLI/integration contracts and useful manual/plugin-free
[Steam launch #290](https://github.com/boburning/portcove/issues/290) remain.
The N64 red/blue/green/yellow direction stands; UI and artwork do not wait for
commissioned branding.

Availability and qualification are distinct. Feasible ports need useful routes
with applicable identity, integrity, source, executable, ownership and operation
checks. Missing owner game data or personal playtesting is not an admission
gate. Unknown gameplay is not a known failure; mandatory failures stay held at
their affected scope. Unknown saves grant no destructive management. Exact
artifact/platform/source/operation evidence cannot qualify unrelated versions
or ports.

## During beta, before 1.0

[Steam Deck #51](https://github.com/boburning/portcove/issues/51) and
[broader platform qualification #45](https://github.com/boburning/portcove/issues/45),
including macOS Intel/Apple Silicon updater/device evidence, remain Required
before 1.0. They consume shared Linux, controller, storage, lifecycle and updater
foundations without delaying initial-beta acceptance. Available builds may work
on unqualified targets; that does not establish official support, Gaming Mode
or Valve Verified claims. Capable agent, hosted or remote evidence is usable;
the owner need not operate a Mac or every qualification device.

[User-ready Playnite #910](https://github.com/boburning/portcove/issues/910),
[Steam Add/Repair/Remove #292](https://github.com/boburning/portcove/issues/292),
[physical controller qualification #44](https://github.com/boburning/portcove/issues/44)
and [optional-at-runtime SteamGridDB #527](https://github.com/boburning/portcove/issues/527)
retain their before-1.0 obligations, outside the initial-beta gate.
[Production requalification #46](https://github.com/boburning/portcove/issues/46),
[lineage #139](https://github.com/boburning/portcove/issues/139) and
[bounded preservation #1306](https://github.com/boburning/portcove/issues/1306)
retain their independent commitments.

## Later independent directions

- [Remembered goals #965](https://github.com/boburning/portcove/issues/965) and
  [standing setup #966](https://github.com/boburning/portcove/issues/966) follow
  independently closable #244.
- [First-family profiles #250](https://github.com/boburning/portcove/issues/250)
  and [retained builds #1456](https://github.com/boburning/portcove/issues/1456)
  are Planned 1.0 after initial beta. Later loaders/sharing and
  [GameBanana **and** Thunderstore #262](https://github.com/boburning/portcove/issues/262)
  do not block that first local-package outcome.
- [Historical releases #40](https://github.com/boburning/portcove/issues/40),
  [game-centered discovery #251](https://github.com/boburning/portcove/issues/251),
  [save transfer #252](https://github.com/boburning/portcove/issues/252), then
  [optional sync #253](https://github.com/boburning/portcove/issues/253).
- [Android #410](https://github.com/boburning/portcove/issues/410) remains
  Post-1.0 Planned and deferred: Rust policy/recovery, Kotlin host facts,
  adaptive React/Tauri presentation and behavior-based qualification.
- [Durable jobs #248](https://github.com/boburning/portcove/issues/248),
  [queue UI #263](https://github.com/boburning/portcove/issues/263), optional
  [MCP #1500](https://github.com/boburning/portcove/issues/1500) after demonstrated
  need, and [engineering automation #284](https://github.com/boburning/portcove/issues/284)
  remain separate from existing recovery, catalog delivery and coordination.

Live fields determine timing and selection. This orientation copies no mutable
assignments, blockers or progress percentages. See
[Project governance](PROJECT-GOVERNANCE.md) for maintenance and
[Delivery](DELIVERY.md) for protected acceptance/publication.
[The previous orientation](https://github.com/boburning/portcove/blob/03a32e71b2394c7b07d883a8412fab98f4a60503/docs/ROADMAP.md)
and [the dated usability migration](archive/2026-10-05-roadmap-usability-redesign.md)
preserve history; current specifications live in
their canonical issues.
