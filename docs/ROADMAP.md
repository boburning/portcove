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

Execution uses one local delivery runner with independent non-writing review.
The retired board preserves historical handoff discovery; it grants no new work.
See [the pickup contract](PROJECT-GOVERNANCE.md#pickup-consumption-and-execution-upkeep).

## Start here

| Question                                     | Authoritative starting point                                                                                                                                                                                                                                        |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| What comes next, and what has shipped?       | [Product Outcomes](https://github.com/users/boburning/projects/1/views/5), grouped by release and including completed outcomes. Issues contain current acceptance and evidence.                                                                                     |
| What prevents the next release?              | [Required for Beta](https://github.com/users/boburning/projects/1/views/6), then complete dependency-derived readiness below. [Required through 1.0](https://github.com/users/boburning/projects/1/views/10) shows later obligations.                               |
| What are runners doing, and what comes next? | [In Progress](https://github.com/users/boburning/projects/1/views/3), [Next Queue](https://github.com/users/boburning/projects/1/views/2) and current ownership/handoff evidence on the owning issues/PRs. Status or Horizon alone does not prove an active writer. |
| Where is approved non-gating work?           | [Planned Additions](https://github.com/users/boburning/projects/1/views/9); these participate in the common execution queue.                                                                                                                                        |
| What is happening with ports?                | Complete [Port Pipeline](https://github.com/users/boburning/projects/1/views/4) and [Active Port Work](https://github.com/users/boburning/projects/1/views/11). Catalog data establishes support.                                                                   |
| What requires the owner's decision?          | Concrete questions in the existing nightly report and the owning issue/PR, with effect and recommendation. Blocked or Deferred alone does not imply owner action.                                                                                                   |

Projects owns live planning fields and the port pipeline. Issues own executable
scope and evidence. Documents own stable contracts and dated history. These
views are navigation, not complete readiness proofs or another roadmap. Expand
native children for included components; collapsed row counts are not totals
of accepted scope or release readiness.

```sh
node scripts/roadmap.mts next
node scripts/roadmap.mts readiness --release "Public beta"
node scripts/roadmap.mts readiness --release "1.0"
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
  where needed, and the **feasible retained frozen cohort after explicit owner-approved product deferrals** in
  [rollout #1422](https://github.com/boburning/portcove/issues/1422).
  Its historical inventory fixes the discovery boundary; #1422 records the approved execution scope; later discoveries enter continuous
  intake. Pilots prove machinery, not rollout completion.
- [Account-free artwork #1155](https://github.com/boburning/portcove/issues/1155)
  and [shared choices/cache/fallback #208](https://github.com/boburning/portcove/issues/208).
  Missing artwork is a specific nonblocking exception, not a port gate.
- [Compatible delivery #246](https://github.com/boburning/portcove/issues/246),
  separately protected [production authority #534](https://github.com/boburning/portcove/issues/534),
  [Windows/Linux application updates #52](https://github.com/boburning/portcove/issues/52),
  applicable security, interruption, recovery and data preservation.

For the exact release artifacts, upgrade paths, packaging and signing
requirements for each claimed platform, follow the
[release task order](RELEASING.md#release-task-order),
[required package matrix](RELEASING.md#declared-package-policy),
[upgrade and recovery guide](UPGRADING.md) and
[independent trust owners](UPDATER-TRUST.md#owners-and-independent-trust-claims).
[Signed in-app updates](RELEASING.md#upgrade-acceptance-and-technical-previews)
retain their platform-specific acceptance; optional
[signed catalog delivery](SIGNED-CATALOG.md) has its own metadata authority.

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

## Port admission and later verification

A port does not need gameplay verification to be available. It needs a valid,
useful integration that passes required admission checks. Verification adds
evidence about how well that same integration works afterward.

| Outcome                                                                      | Completion boundary                                                                                                                                                                                                                                                                 |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Fast onboarding #254](https://github.com/boburning/portcove/issues/254)     | Reusable definition/artwork/evidence preparation, applicable checks and repeated ordinary authoring/maintenance use.                                                                                                                                                                |
| [Frozen rollout #1422](https://github.com/boburning/portcove/issues/1422)    | Account for all historical 317 records / 316 identities; deliver the feasible retained 301-identity cohort after the explicit 15 product deferrals in #1422, preserving existing integrations and genuine holds/duplicate evidence. Later discoveries do not expand Required scope. |
| [Compatible delivery #246](https://github.com/boburning/portcove/issues/246) | Its independent new-definition → ordinary-compatible-artifact → compatible-correction journey on unchanged capable clients through protected acceptance/publication; actual provisioning remains [#534](https://github.com/boburning/portcove/issues/534).                          |
| [Direct qualification #42](https://github.com/boburning/portcove/issues/42)  | The finite risk-based representative runtime/gameplay/audio/control/save-load commitment remains Required 1.0, outside ordinary beta admission.                                                                                                                                     |

Ordinary admission requires attributable project/game/implementation identity,
an exact platform/architecture and useful route, demonstrated fit with implemented
source/package/preparation/executable/write/persistence/ownership/release contracts,
applicable definition/input/artifact/integrity/safety checks and independent review.
Players need clear prerequisites, usable actions, truthful limitations and scoped
known failures, artwork preparation or a specific permitted working fallback,
an accurate maintenance declaration and the applicable accepted delivery path.
Required use-time input checks can be established without the developer possessing
every player's game files. Known mandatory failures remain failures at their scope.

Definition preparation/acceptance, useful integration actually available to users,
and later observations are separate results. Drafts and fixture publication do not
establish user delivery. A finite admission can finish with optional observations
**Not tested**; other genuinely required work remains open. Personal installation,
gameplay, every platform and every lifecycle operation are not universal admission
gates. Offered operations keep their real safety and explicit acceptance obligations.

Existing-capability additions ordinarily supply facts and parameterized cases
through existing machinery, without application or bespoke harness changes.
Actual source/setup/executable/write/release behavior establishes fit, rather than
engine or console ancestry. Genuinely missing behavior gets the smallest safe
extension under its existing owner, or isolated title glue where appropriate.
Reuse equivalent coverage; do not invent an abstraction, duplicate tests or require
a second title for every ordinary addition. Difficult candidates do not stop
unrelated fitting additions and remain in the feasible-backlog commitment.

Later evidence uses the same port identity, definition lineage and library
relationship. No separate verified/unverified catalog or reinstall is needed.
Admission, offered operations/current eligibility, integrity/ownership, automated
lifecycle results, direct observations, known failures and upstream release
channel/maintenance policy remain distinct. Record observations at actual
artifact/version, platform, operation, method, result, date and limitations;
new artifacts never inherit gameplay. Risk, known problems, reports and available
usage evidence guide later coverage without a universal personal-testing queue.

[Reusable scenario/operation-time evidence #1742](https://github.com/boburning/portcove/issues/1742)
remains Planned 1.0. Broader optimization, all-family coverage and optional
verification do not become new Required beta gates. Final rollout consumes its
owners' required minima; independent authoring, evidence and capability work can
proceed before protected production execution. Use existing proposal/completion
reports for reused/new work and observed costs, keeping unknown baselines explicit.
Intended tooling stays in issue specifications until shipped.

## Required beta browsing

[Composable catalog/library queries #1550](https://github.com/boburning/portcove/issues/1550)
retain small, explainable filters and current browsing state. Separate owners cover
[local file/attention/update snapshots #1551](https://github.com/boburning/portcove/issues/1551),
[lightweight Favorites #1552](https://github.com/boburning/portcove/issues/1552) and
[later metadata, feature and recency browsing #1553](https://github.com/boburning/portcove/issues/1553).
[Saved queries/sharing #1554](https://github.com/boburning/portcove/issues/1554) and
[exact evidence browsing #1555](https://github.com/boburning/portcove/issues/1555) remain later independent additions.
Composable queries, local snapshots and Favorites are Required Public beta
outcomes under the owner's October 10 commitment decision. The later metadata,
saved-query and evidence-browsing owners retain their existing later targets and
commitments. Live Project fields determine release readiness; this decision does
not establish completion or qualification for any browsing component.
Unknown facts remain visible in unfiltered browsing; operational filters reuse
Core snapshots and do not authorize work or establish qualification. See the
[dated reconciliation](archive/2026-10-05-browsing-reconciliation.md).

Chips, detail rows and filters reuse truthful scoped facts rather than quality
ratings. [#206](https://github.com/boburning/portcove/issues/206) owns bounded
state/copy corrections; [#917](https://github.com/boburning/portcove/issues/917)
owns passive/interactive semantics and accessible emphasis. Planned
[#1553](https://github.com/boburning/portcove/issues/1553) adds a small attributable
capability contract and its first consumers before broader comparison under
[#251](https://github.com/boburning/portcove/issues/251). Unknown testing does not
block admission, a source match is not playability, and an update does not erase
readiness. See the [dated chip reconciliation](archive/2026-10-05-chip-roadmap-reconciliation.md).

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

## Local-first diagnostics

This is planned specification work, not a claim that the following machinery
has shipped. Runtime diagnostics explain behavior; Core activity/lifecycle
persistence establishes committed outcomes, recovery and safe continuation;
captured preparation/tool/game output retains its own supervision, storage,
retention and completeness contract. Neither a missing completion log nor a
completion event determines mutation success. Logging failure must not change
an otherwise successful operation. Do not migrate these stores merely for
uniformity or make diagnostic logs another application authority.

The bounded inspection at main `eea77d8d16a8adad8456346c598e4f3a32159fce`
found synchronous desktop per-event metadata/open/write/sync work, ignored span
context/string-only fields, initialization after library opening, and fail-fast
support-bundle section collection. CLI tracing writes to stderr with explicit
verbosity. This is source evidence, not proof that logging caused any previous
timeout. Existing redaction, rotation, bounded activity captures, snapshot-rewrite
avoidance [#990](https://github.com/boburning/portcove/issues/990), early safe stderr
[#1465](https://github.com/boburning/portcove/issues/1465), retained log readback
[#1494](https://github.com/boburning/portcove/issues/1494), and diagnostic copy/fallback
[#1704](https://github.com/boburning/portcove/pull/1704) remain credited at their actual
scope. [#566–#570](https://github.com/boburning/portcove/issues/566) retain structured
failure, adapter parity, activity, capture and interrupted-recovery foundations.

The independent delivery slices are:

| Outcome                                                 | Canonical owner                                            | Interface dependency                                                                                                        |
| ------------------------------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Bounded writer and independent health                   | [#1922](https://github.com/boburning/portcove/issues/1922) | Consume #33 measurements where useful; no profiling prerequisite.                                                           |
| Shared host policy, early startup and isolated sessions | [#1923](https://github.com/boburning/portcove/issues/1923) | Shared bounded backend when adopted; early fallback can ship independently.                                                 |
| Safe typed operation and frontend correlation           | [#1924](https://github.com/boburning/portcove/issues/1924) | Approved formatting/classification and existing operation IDs; no blanket host migration gate.                              |
| Resilient support bundles and focused controls          | [#1925](https://github.com/boburning/portcove/issues/1925) | Each exported class needs #34 policy; startup-only sections need host log access, existing-library partial export does not. |

These are approved long-term improvements, with live priorities and release
classifications in the Project rather than a copied scheduling table here.
[#33](https://github.com/boburning/portcove/issues/33) retains its bounded
durability measurement and evidence-backed keep/change decision;
[#34](https://github.com/boburning/portcove/issues/34) retains typed export data
classification. Neither investigation becomes an umbrella or a blanket gate.
[#202](https://github.com/boburning/portcove/issues/202) retains Required Public beta
semantic errors, truthful committed/unknown/recovery outcomes and its finite
remaining acceptance. These new diagnostics enhancements do not defer that
acceptance or silently add beta requirements. Live Project fields own scheduling.

The desktop bounded writer, independent health readback, finite exit flush,
versioned typed operation/span observations and bounded frontend reports are
implemented in the [runtime diagnostics contract](ARCHITECTURE.md#runtime-diagnostic-writer).
Shared CLI host policy and isolated session files retain their separate owner
below. Runtime writing and activity-capture durability remain distinct; a
diagnostic session ID does not imply isolated files.

### Policy and planned coverage

- Retain tracing/tracing-subscriber. Executables initialize subscribers; Core
  emits instrumentation. Share only useful host policy/formatting/redaction,
  bounded writing, retention and health; no Tauri dependency in Core/CLI, new
  event bus, or plugin replacement for consolidation. CLI JSON/JSONL stdout and
  raw child-process stream contracts remain exact.
- Runtime writing is best-effort with bounded queue, fields, record size and
  producer work; disk work stays off application-critical paths. Saturation
  drops/truncates explicitly rather than waiting indefinitely. Independent,
  nonrecursive health reports omissions and writer/rotation failures. A finite
  shutdown flush can lose records on abrupt exit; do not promise crash-proof
  delivery. Disk/permission failures do not change committed outcomes.
- Initialize in an appropriate per-user host location before settings/library/
  database startup, retaining early safe stderr. Isolate process/session files
  with aggregate retention across sessions; library switching attaches safe
  context without replacing logging authority. An unclean session has no
  inferred cause; Core owns recovery.
- Use a small versioned envelope, preserving numbers/booleans and approved span
  context. Bind meaningful phase events to existing activity/operation identities,
  session/process, surface/build/component, useful request and port/release facts,
  monotonic duration, typed error and observed result/unknown limits. One owning
  boundary reports each failure; lower layers add typed context. Avoid tick/file/
  function noise and invented parallel operation identities.
- Privacy applies before persistence and again at export. Approved fields and
  symbolic path roles replace indiscriminate Debug/object/argument serialization.
  Cover messages, spans, nested errors, frontend payloads and captures; omit
  credentials, auth headers, signed query parameters, environments, game contents,
  broad source inventories and unnecessary absolute paths. Exports are redacted,
  not anonymous; preserve existing canaries/redaction while adding typed policy.
- Support bundles collect independent bounded sections through established
  activity/capture reads, with a versioned manifest recording scope, build/platform,
  provenance, omissions, failures and completeness/truncation. An unavailable
  library or failed doctor section must not prevent available diagnostics from
  exporting. Prefer streaming, safe entry names and atomic completed publication;
  tolerate rotation and incomplete trailing records. Do not copy the database or
  arbitrary filesystem content. Export/sharing stays user-initiated.
- Keep frontend reporting on the existing backend command with typed size/rate
  limits and recursion protection, without console/state/IPC-argument forwarding.
  Correlation grants no operation authority. Large child output remains in bounded
  captures; reaching retention limits must not stop pipe draining or supervision.
  Existing activity captures use separate 2 MiB per-stream/64 MiB retained-library
  bounds at the inspected revision; runtime settings must not redefine them.

Candidate defaults for shared host/session policy remain application INFO/noisy
dependency WARN, temporary DEBUG that resets at session end, and a 32 MiB
aggregate session budget. The desktop writer retains 4 MiB segments and five
rotated generations (24 MiB) with seven-day expiry of exact owned names. CLI
still defaults WARN with explicit verbosity. Each remaining owner records
measured capacities, active-session retention/failure behavior, DEBUG reset/expiry
and CLI compatibility before changes.
No unrelated CI-policy, dependency, remote telemetry, hosted logging, account,
query service, comprehensive viewer or universal game-capture project is implied.

Start with a bounded writer/failure fixture and independent health evidence;
partial export fixes and early startup fallback can proceed independently.
Only genuine interface/data-class dependencies constrain their matching changes,
not a four-phase waterfall. Typed classification is required for each newly exported
class; existing-class export resilience need not wait for complete enrichment.
Focused owned Windows/Linux fixtures, privacy canaries, exact CLI/operation outcome
controls and separate review provide evidence. No owner playtest, proprietary game
data, paid Actions or owner-operated Mac requirement is introduced.

## Optional Docker development tooling

Owner decision, 2026-10-15: two finite development-speed outcomes are authorized
for the existing Windows development PC and local runner. Browser tooling comes first; Linux build and
unsigned packaging starts only after the shared host preflight, committed-source
isolation, orchestration, result export and cleanup have actual Windows-to-Linux
container evidence:

1. [Optional Windows-driven Docker browser testing #2006](https://github.com/boburning/portcove/issues/2006).
2. [Separate Linux build and unsigned packaging #2007](https://github.com/boburning/portcove/issues/2007),
   blocked by #2006's implemented and demonstrated shared adapter.

The [optional browser adapter](reference/docker-browser-tooling.md) provides the
Windows host commands, committed-source selection, retained evidence and scoped
cleanup contract. #2006 owns its actual execution evidence. The separate builder
keeps #2007's scheduling and packaging scope.

The Project placement is **Public beta / Planned**, not Required: target useful
delivery before beta where capacity permits, without blocking any existing
Required beta outcome. Only the builder depends on the browser outcome; no
reverse beta-release dependency or new parent/epic is authorized.

Docker Desktop with the WSL 2 Linux-container backend is optional developer
tooling, not application deployment, mandatory contributor setup, another runner
or a native Linux desktop qualification host. The ThinkPad T480 is unconfigured
and excluded from all work, evidence and prerequisites. Native Windows builds,
development and platform tests remain usable with Docker stopped. There is no
ordinary CI migration, paid infrastructure/Actions requirement, signing,
publication, security-acceptance, platform-qualification or release-gate change.

The [completed Vite+ modernization record](reference/viteplus-modernization.md)
classified Docker/packaging as inapplicable within that completed migration.
That retained historical disposition does not prohibit these newly
authorized optional build/test environments, and does not reopen
[#2001](https://github.com/boburning/portcove/issues/2001).
Follow-up [#2004](https://github.com/boburning/portcove/issues/2004) owns Vite+ task,
browser and bootstrap consolidation; container implementation must consume its
actually delivered commands and pins without taking over that work.
[#1036](https://github.com/boburning/portcove/issues/1036) retains browser coverage;
[#1615](https://github.com/boburning/portcove/issues/1615) retains separate portable
capability work. None gains a Docker prerequisite.

Both outcomes stage an explicitly selected committed revision, including unpushed
commits, into isolated Linux storage and record requested/executed commit and
tree. Dirty current work must be refused or explicitly excluded by a deliberate
committed-selection request; no silent omission, automatic commit/stash/reset/
push/branch switch or v1 dirty synchronization. Keep Linux dependencies, browser
cache, Cargo output and scratch separate from native Windows state. Reuse existing
storage, guarded-command, browser-bootstrap/trace, build and package helpers.
Validate Docker virtual-disk backing Windows volume as well as container/export
capacity; Linux paths do not bypass the maintainer's storage policy. No automatic
host-feature, reboot, Docker-data relocation or global-resource-setting changes.

Browser tooling uses a compatible pinned Vite+ image, all frozen installation
inputs and the repository's contained browser runtime/failure probe; Rust and
packaging dependencies stay out absent an actual browser requirement. The separate
builder revalidates the supported release baseline (Ubuntu 22.04 x86-64 at
inspection), reuses the Linux prerequisite installer and existing Linux PowerShell
CLI packaging/smoke helpers, and reports AppImage, deb and rpm independently.
Compilation/package evidence is not native installed-application qualification.

Cache preparation/downloads, never fresh acceptance. Warm commands actually rerun
tests/builds and export causal status, logs/traces, source/environment identity
and artifact hashes; preserve owned resources if export fails. Bound runtime and
storage, use non-root tasks/minimal mounts and environment, and retain inspectable
labels/dry-run cleanup protecting active runs and failure evidence. No host home,
game library, signing credentials, Docker socket, broad privilege/capabilities,
host networking, privileged FUSE, machine-wide prune or sandbox guarantee.
Maintain image pins through verified existing dependency extraction/coordination;
record local image ID/base pin and mutable installed-package identities. No
unproven offline, reproducibility or speedup claim. Candidate commands
`container-doctor`, `container-browser` and `container-clean` are **planned names**,
not available tooling. Each issue requires separate review, real Windows-host
integration, cold/warm/failure/interruption evidence and unchanged native commands.

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
