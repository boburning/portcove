> Historical audit evidence. Canonical GitHub issues own implementation scope, and Project fields own live priority, status, and release target. This file is not a live roadmap authority. Current-main revalidation may change a finding's disposition without rewriting this evidence. This final audit supersedes the earlier Portcove wording audit.

# Portcove UX copy, content, and interaction audit

Audit date: 2026-09-04  
Repository: `boburning/portcove`  
Snapshot: [`e07bb4b890bfbca37f493f173827e615ca9ac77d`](https://github.com/boburning/portcove/tree/e07bb4b890bfbca37f493f173827e615ca9ac77d) (`origin/main`)  
Repository changes made: none

## Executive summary

Portcove’s safety model is unusually well documented, and its internal vocabulary is generally consistent. The main UX problem is that internal architecture and project-governance terms are routinely presented as player-facing language. Terms such as *adapter*, *source profile*, *source reference*, *provenance*, *materialization*, *persistent data*, *qualification*, *replay floor*, and *managed version* are accurate to the implementation but force users to understand the implementation before they can complete ordinary tasks.

A second, equally important problem is that Portcove sometimes uses broad words such as *verified*, *reviewed*, and *trusted* without naming the exact property that was checked. A matching checksum, valid catalog signature, trusted publisher key, exact game-file hash, successful automated test, and completed hands-on test are different claims. The interface should identify them separately rather than compressing them into a generic “Verified” status.

The highest-value improvements are:

1. Establish a precise product-language contract for verification, trust, readiness, game files, installed versions, and recovery.
2. Give human-facing errors structured summaries, recovery actions, mutation outcomes, and expandable technical details instead of rendering raw core messages.
3. Define one canonical readiness-state model across the desktop and CLI so every blocked state names the problem and the next action.
4. Rewrite source registration and discovery around **game files**, exact-match results, and full expected/found SHA-256 values.
5. Make library restore, library move, source removal, cancellation, update policy, and destructive confirmations state exactly what changes and what remains.
6. Stop rendering raw adapter values, enum values, UUIDs, source-profile IDs, port IDs, Unix timestamps, byte counts, and internal field names as primary desktop copy.
7. Separate update-setting changes from downloads or installations, or add an explicit review step before any side effects occur.
8. Resolve the archived-upstream contradiction between `SECURITY.md` and `docs/CATALOG.md`.
9. Move catalog characteristics such as build method, required game files, platforms, test status, release channel, and upstream state into structured fields instead of overloading freeform summaries.
10. Add localization, accessibility, copy-governance, and regression-testing requirements so the wording does not drift back toward implementation language.

No P0 issue was found.

- **P0 — Critical:** A statement or interaction could directly cause data loss, credential exposure, security compromise, or a materially false safety guarantee.
- **P1 — Must fix:** The wording or interaction could mislead a consequential decision, obscure a required action, falsely imply verification or safety, turn an expected cancellation into an error, or contradict a public contract.
- **P2 — Should fix:** A material clarity, consistency, accessibility, or discoverability improvement.
- **P3 — Polish:** Low-risk grammar, punctuation, tone, or maintainer-output cleanup.

## Scope and method

The audit covered all 295 files in the pinned snapshot, approximately 49,000 text lines, including:

- desktop UI text, accessibility labels, tooltips, keyboard hints, empty states, banners, dialogs, command-palette entries, progress text, and error surfaces;
- CLI descriptions, arguments, prompts, progress, tables, errors, and human-mode fallback rendering;
- surfaced core errors and progress phases;
- the embedded catalog’s labels, summaries, maturity fields, and source requirements;
- root and `docs/` documentation, setup and release instructions, security text, GitHub forms, PR text, Tauri metadata, and maintainer scripts;
- test expectations when they revealed text emitted by production code.

There are no sample `.env`, configuration-example, or similar user-facing config files in this snapshot. Historical documents under `docs/archive/` were reviewed for present-day ambiguity. Their historical-evidence notices already prevent them from reading as current policy, so their preserved body text is not included as rewrite work.

The findings below are exhaustive at the recommendation level. Repeated occurrences of the same problem are consolidated into one finding with every affected surface or an explicit replacement pattern. Machine-field names, JSON enum values, hashes, legal text, third-party dependency metadata, binary assets, and test-only fixtures are excluded unless they are shown to a person.

## Change-type model

Each finding should be tracked with both a priority and a change type. A wording-only change should not be used to conceal an interaction or product-policy problem.

| Change type | Meaning |
|---|---|
| **Copy only** | Replace visible text without changing behavior or data. |
| **Presentation mapping** | Map internal values to approved labels, formatted values, or display names. |
| **Interaction design** | Change controls, review steps, information hierarchy, or action flow. |
| **Error architecture** | Add stable error codes, parameters, recovery actions, mutation outcomes, or technical-detail separation. |
| **Data model** | Add or separate structured catalog or application fields. |
| **Product policy** | Resolve or change a public security, support, or lifecycle rule. |
| **Documentation structure** | Reorganize material without changing the underlying contract. |

## Product-language principles

1. **Name the exact property that was checked.** Do not use a standalone “Verified” badge or broad “verified release” claim when the system only knows that a signature, hash, file set, installation, or test result matched.
2. **Describe the outcome before the mechanism.** Say “Builds a native version locally from your disc” before describing the toolchain or adapter.
3. **State the mutation boundary.** Consequential copy should say what Portcove will change, copy, delete, preserve, or leave untouched.
4. **Use recognizable names first.** Desktop UI should show port names, source labels, dates, and paths before IDs. CLI output should generally show both the recognizable name and the copyable ID.
5. **Never derive human text by replacing underscores or hyphens in enum values.** Every user-visible status, phase, operation, adapter, platform, and reason needs an approved display mapping and a safe unknown-value fallback.
6. **Do not replace jargon with a single universal synonym.** Terms such as `adapter`, `source profile`, `provenance`, and `materialization` mean different things in different contexts and need context-specific language.
7. **Preserve exact technical evidence where it helps users act.** Full hashes belong in the game-file matching flow; exact IDs, paths, codes, and raw messages belong in technical details and structured CLI output.
8. **Use real pluralization.** Never render `file(s)`, `port(s)`, `match(es)`, or similar parenthetical plurals.
9. **Make copy localizable and accessible.** Avoid string concatenation, slash-separated alternatives, rapidly announced progress counters, color-only statuses, and hard-coded platform-specific shortcut labels.
10. **Do not make stronger guarantees than the implementation can prove.** Phrases such as “privacy-safe,” “still running safely,” “no files were changed,” and “legally obtained” require evidence or should be replaced with narrower statements.

## Canonical verification and trust language

| What Portcove knows | Approved user-facing language | Avoid |
|---|---|---|
| Signed catalog passes signature validation | **Catalog signature valid** | Verified catalog |
| Catalog was signed by a key the user trusts | **Signed by a trusted publisher** | Trusted catalog, unless the whole trust model is explained |
| Downloaded artifact matches the expected digest | **Download matches the expected SHA-256** | Verified release |
| User-provided game file matches an accepted digest | **Exact game-file match** | Verified source |
| Installed application files match the recorded version | **Installed files match version {version}** | Verified installation, unless the object is named |
| Automated compatibility or integrity checks passed | **Automated checks passed** | Fully tested, qualified |
| Hands-on testing was completed | **Tested by Portcove on {platform}** | Verified on {platform} |
| Hands-on testing has not been completed | **Not yet tested by Portcove on {platform}** | Untested, when upstream or automated evidence exists |
| Upstream repository is archived | **Upstream project archived** | Retired and unsupported, unless support ownership is explicit |
| A release is pinned to a digest in the catalog | **Release file pinned by SHA-256** | Checksum-qualified, checksum-pinned release in primary UI |

## Canonical product vocabulary

| Internal term | Standard desktop language | CLI or advanced details |
|---|---|---|
| `adapter` | Usually omit. When necessary, split into **Build method**, **Installation method**, and **Required game files**. | Integration method or adapter ID may appear in technical details. |
| `source profile` | **Game-file requirement** | Show the source label and ID together where commands require the ID. |
| `source reference` | **Added game file** or **saved file location**, depending on context | Source record or source ID in details. |
| `persistent data` | **Saves and settings** | Persistent-data path in technical details. Include mods only when preservation is guaranteed. |
| `provenance` | **Release source** or **catalog origin**, depending on context | Provenance may remain in security and architecture documentation. |
| `qualification` | **Portcove test status** | Qualification evidence in maintainer-facing reports. |
| `managed version` | **Installed version** | Managed-version record in technical details. |
| `materialization` | **Prepare game files**, **extract files**, **convert files**, or **create a working copy**, depending on the actual operation | Materialization operation in developer details. |
| `runtime` | Use the exact component name. If no useful name exists, use **required component**. | Runtime package, runtime source, or runtime ID in technical details. |
| `adopt` | **Copy existing installation** | Keep `adopt` as the stable CLI command. |
| `rollback` | **Restore previous version** | Keep `rollback` as the stable CLI command and technical term. |
| `native PC port` | **Native game port** | Use exact supported platforms in structured fields. |

## Canonical readiness states and actions

Portcove should use one state model across cards, detail views, dialogs, activity history, and CLI summaries.

| Condition | Status label | Explanation pattern | Primary action |
|---|---|---|---|
| Port is not installed | **Not installed** | “Install this port to add it to your Portcove library.” | **Install** |
| Required game files have not been added | **Game files required** | “Add the required original game files before installing or playing.” | **Choose game files** |
| Selected game file does not match | **Game file doesn’t match** | “The selected file has a different SHA-256 from the supported version.” | **Choose another file** |
| Required downloadable component is missing | **Update required before playing** | “Install the available update that includes the required component.” | **Review update** |
| First-run setup has not completed | **Setup required** | “Run the port’s setup before playing for the first time.” | **Run setup** |
| Port is installed and all requirements are satisfied | **Ready to play** | “The installed version and required game files are ready.” | **Play** |
| A newer release is available | **Update available** | “A newer release is available for this port.” | **Review update** |
| An update is downloaded but not active | **Update ready to install** | “The update has been downloaded and checked.” | **Install update** |
| Installed files differ from the recorded version | **Installation may be damaged** | “One or more installed files have changed or are missing.” | **Verify installation** |
| A previous installed version can be restored | **Previous version available** | “Portcove kept the previous version for recovery.” | **Restore previous version** |
| An operation stopped reporting completion | **Needs review** | “This task may have been interrupted. Review the details before retrying.” | **Review activity** |
| Port is unavailable on the current platform | **Not available for this platform** | “This port does not provide a build for {platform}.” | None |

Every blocking state should answer four questions:

1. What is wrong?
2. Why does it matter?
3. What should the user do?
4. What did Portcove leave unchanged?

# Findings

## 1. Cross-surface language and presentation contract

| ID | Priority | Change type | Affected surfaces | Recommendation | Rationale |
|---|---|---|---|---|---|
| SYS-01 | P1 | Error architecture | Desktop banners, dialogs, CLI human output, and surfaced errors from `crates/portcove-core/src/` | Replace the single-string error contract with a stable error code, structured parameters, a human summary key or presentation mapping, zero or more typed recovery actions, a mutation/recovery state, and separate technical details. JSON/JSONL should retain exact codes and fields. | One string currently serves logs, integrations, CLI users, and desktop users. That guarantees technical leakage and makes many errors unactionable. |
| SYS-02 | P1 | Copy governance | All uses of *verified*, *reviewed*, *trusted*, *qualified*, and related badges | Apply the canonical verification table above. Every status must name the object and property checked. Remove standalone **Verified** badges. | These words currently collapse different security and compatibility claims and can overstate what Portcove proves. |
| SYS-03 | P1 | Presentation mapping | `adapter`, `source profile`, `source reference`, `persistent data`, `provenance`, `qualification`, `managed version`, `materialization`, and `runtime` across desktop, CLI, README, and catalog | Apply the context-sensitive vocabulary table above. Do not implement a mechanical one-to-one replacement. | A universal synonym would preserve ambiguity or create inaccurate labels. |
| SYS-04 | P1 | Interaction design | Port cards, detail view, update center, CLI status, and launch blockers | Implement the canonical readiness-state model above. Each blocked state must have one primary remedy and consistent status text across surfaces. | The same condition currently appears under conflicting or incomplete labels such as “ready; setup pending,” “verified runtime required,” and “unlock Play.” |
| SYS-05 | P1 | Interaction design | Source removal, library restore/import, library move, backup restore/delete, installed-version removal, update-policy application | Every consequential review must state: what changes, what remains, which ports or files are affected, whether the action can be undone, and whether originals are modified. Use result-naming buttons. | Wording alone is insufficient when a compact confirmation hides multiple consequences. |
| SYS-06 | P1 | State semantics | Desktop and CLI cancellation/dismissal paths | Treat an explicit user cancellation as a neutral outcome: **Cancelled** or no result. Reserve error styling and nonzero failure semantics for operations that failed to cancel or ended unexpectedly. | Choosing Cancel is expected behavior, not an application failure. |
| SYS-07 | P1 | Presentation mapping | Progress phases, adapter values, target kinds, activity statuses, fallback reasons, error-detail keys | Never create labels by replacing underscores or hyphens. Use approved maps and render unknown values as **Unknown status** or **Unrecognized value**, with the raw value in technical details. | Mechanical formatting exposes implementation terms and fails unpredictably when enums change. |
| SYS-08 | P2 | Presentation mapping | Counts throughout desktop, dialogs, CLI, and scripts | Use a shared pluralization system and full count-aware variants. Prohibit parenthetical plurals such as `file(s)` and `match(es)`. | Fixes visible grammar defects and supports localization. |
| SYS-09 | P2 | Presentation mapping | Unix timestamps and byte counts in `human.rs`, `main.rs`, Tauri dialogs, progress, backups, and activity history | Desktop: locale-aware local date/time, with timezone or ISO value in details. CLI: unambiguous ISO-8601 with offset by default. Show human-readable IEC sizes; retain exact Unix seconds and bytes in JSON/JSONL. | Users should not have to decode timestamps or calculate sizes before acting. |
| SYS-10 | P2 | Presentation mapping | Platform labels across desktop, docs, issue forms, and CLI | Standardize display names to **Windows (x64)**, **Linux (x64)**, **macOS (Intel)**, and **macOS (Apple silicon)**. Keep canonical enum values in machine output. | Removes raw identifiers and inconsistent Apple terminology. |
| SYS-11 | P2 | Presentation mapping | Port IDs, source-profile IDs, UUIDs, backup IDs, key IDs, and target IDs | Desktop: show names, labels, dates, and paths first; put IDs in technical details. CLI: generally render `Display name (id)` so the identifier remains copyable. | Desktop users should not have to recognize database keys, while CLI users still need operational identifiers. |
| SYS-12 | P2 | Accessibility | Progress announcements, all-caps headings, keyboard/gamepad hints, status color, visible/accessibility labels | Throttle live-region announcements to meaningful phase changes; provide sentence-cased accessible names; never rely on color alone; keep visible and accessible action names aligned; adapt shortcut glyphs to OS and active input device. | Prevents noisy screen-reader output and misleading or platform-inaccurate guidance. |
| SYS-13 | P2 | Localization | All interpolated human strings | Avoid fragment concatenation and slash-separated alternatives. Format complete messages with locale-aware count, date, number, and size utilities. Test zero, one, many, unknown, and large values. | English-only concatenation patterns will not localize reliably and already produce grammar defects. |
| SYS-14 | P2 | Copy governance | Source code and tests | Add a user-facing terminology lint or allowlist. Flag `adapter`, `materialization`, `qualification`, `persistent data`, `source profile`, raw enum formatting, parenthetical plurals, and generic “Verified” in standard desktop strings. Permit them in developer docs and technical-detail components. | Prevents the same wording problems from returning after the audit is implemented. |

## 2. Desktop UI

### Global chrome, settings, and startup

| ID | Priority | Change type | Path | Current wording or behavior | Final recommendation |
|---|---|---|---|---|---|
| UI-01 | P2 | Copy only | `apps/desktop/src/components/Chrome.tsx:58` | “Explore {count} curated decomps and recompilations with explicit release provenance.” | “Explore {count} native game ports and recompilations available through Portcove.” Follow with a separate benefit statement such as “Keep original game files local, review updates, and restore previous versions.” Do not use *reviewed* or *verified* here unless the scope of that claim is defined. |
| UI-02 | P2 | Copy only | `Chrome.tsx:59` | “See every version decision, staged release, and failure in one place.” | “Review available updates, downloaded releases, and failed checks in one place.” |
| UI-03 | P2 | Copy only | `Chrome.tsx:60` | “Control appearance, authentication, source integrity, and local storage boundaries.” | “Manage appearance, GitHub sign-in, game-file verification, and library storage.” |
| UI-04 | P2 | Interaction design | `Chrome.tsx:136-142` | Dense explanation of GitHub allowance and conditional checks; “Rate allowance unavailable.” | Lead with “Sign in to GitHub for a higher release-check limit.” Show **GitHub request limit unavailable** or “{x} of {y} GitHub requests remaining” as secondary status. Move conditional-request behavior to a tooltip or help text. |
| UI-05 | P1 | Interaction design | `Chrome.tsx:167` | “Device login needs a Portcove GitHub App client ID in this build…” | Hide or disable device sign-in when the capability is unavailable. If a fallback message is still needed: “This version of Portcove does not support GitHub device sign-in. Continue anonymously or use a personal access token.” Do not expose the build-time client-ID requirement. |
| UI-06 | P2 | Copy only | `Chrome.tsx:183-185` | “Installed ports have every required source reference.”; “{n} source requirement(s) need attention” | “All required game files have been added for your installed ports.” Use count-aware variants: “1 game-file requirement needs attention” / “{n} game-file requirements need attention.” |
| UI-07 | P2 | Copy only | `Chrome.tsx:202,208` | Heading “Integrity”; explanation uses “source profile.” | Heading: **Game-file verification**. Body: “Portcove checks files locally and never uploads or changes them. When you choose a new location, Portcove confirms that the file is an exact match before saving the new path.” |
| UI-08 | P3 | Copy only | `Chrome.tsx:247-248` | “One harbor for native ports”; body uses “managed versions” and “recovery-safe history.” | Keep the tagline. Replace the body with: “Portcove keeps the desktop and CLI in sync across the catalog, game files, installed versions, and recovery history.” |
| UI-09 | P2 | Interaction design | `Chrome.tsx:266-267` | “Redacted support bundle”; proposed “privacy-safe support bundle.” | Use **Create support bundle**. Explain exactly what is excluded: “Collect recent logs, operation history, and system details without game-file contents or saved credentials.” Provide a preview or disclosure if usernames, paths, or other personal metadata can remain. Avoid the absolute claim “privacy-safe.” |
| UI-10 | P2 | Copy only | `Chrome.tsx:300-305` | “Source tools”; “validation or materialization.” | **Disc tools**; “Checking disc-tool availability…”; “These optional tools are used only when Portcove must check, extract, or convert supported compressed disc formats.” |
| UI-11 | P2 | Copy only | `Chrome.tsx:336-343` | “{total} volume”; “Application versions are isolated from saves…”; “Export source references…” | Use a meaningful quantity label such as **Portcove library size** or **Storage used**, not “{total} total.” “Installed application files are kept separate from saves and settings.” “Export saved game-file locations and installed-version settings.” Mention mods only if preservation is guaranteed. |
| UI-12 | P2 | Copy only | `apps/desktop/src/App.tsx:32` | “Portcove initialization failed without an error report.” | “Portcove could not start, and no error details were provided.” |
| UI-13 | P1 | Copy only | `App.tsx:39-56` | “Opening your native library”; backend-oriented loading copy; “Your library needs attention.” | “Opening your Portcove library”; “Loading the catalog, recovery history, and release information.”; “Portcove couldn’t open your library.” Do not imply that the user’s data is at fault until the cause is known. |
| UI-14 | P1 | Interaction design | `apps/desktop/src/ErrorBoundary.tsx:31-34` | “DESKTOP RECOVERY”; “Your library operation state remains owned by the backend…”; “Unknown render failure.” | Visible heading: **Display error**. Body: “The Portcove window encountered an error. Reload it to reconnect and check the status of any active task.” Use **Unknown display error** in details. Do not claim the operation is still running safely unless that state is known. |

### Port browser and detail view

| ID | Priority | Change type | Path | Current wording or behavior | Final recommendation |
|---|---|---|---|---|---|
| UI-15 | P2 | Copy only | `apps/desktop/src/components/PortBrowser.tsx:34,38` | “Reading the shared local catalog, sources, and install state.”; “adopt an existing native installation.” | “Loading the catalog, added game files, and installed ports from this device.”; “copy an existing supported installation into Portcove without changing its original folder.” |
| UI-16 | P2 | Presentation mapping | `PortBrowser.tsx:48,55-58` | “Last successful session”; “Launch ready”; “Need setup”; “Staged updates”; “Sources stay local. Managed versions remain rollback-safe.” | “Last played”; “Ready to play”; “Setup required”; “Updates downloaded”; “Game files stay on this device. Previous installed versions can be restored.” Apply the canonical readiness labels. |
| UI-17 | P1 | Data model | `PortBrowser.tsx:67`; `DetailPanel.tsx:82` | Raw adapter enums are converted into labels such as “libultraship portable” and “generated cache.” | Remove the adapter eyebrow from primary cards unless it helps a task. Where needed, store and display separate structured attributes: **Build method**, **Installation method**, and **Required game files**. Do not map adapter enums to a single mixed “project type.” |
| UI-18 | P2 | Copy only | `PortBrowser.tsx:87` | “Play options” opens the detail panel. | **View details**. |
| UI-19 | P3 | Copy only | `DetailPanel.tsx:105` | “Verified releases / Sources stay local / Rollback retained.” | Use precise, parallel claims: “Downloads checked by SHA-256 / Game files kept local / Previous version kept for recovery.” Only show each claim when it is true for the current port and operation. |
| UI-20 | P2 | Copy only | `DetailPanel.tsx:146` | “Retired upstream. This pinned release receives no upstream fixes or support.” | “The upstream project is archived. Portcove can still install its pinned release, but no new upstream fixes are expected.” Name Portcove support separately if Portcove still supports the catalog entry. |
| UI-21 | P2 | Interaction design | `DetailPanel.tsx:158-166` | “Release, sources & maintenance”; governance-oriented information order. | Reorganize the panel in task order: **Current status and primary action**, **What you need**, **Installation and version**, **Updates**, **Saves and storage**, **Compatibility and testing**, **Project and release information**, **Technical details**. Renaming the existing heading alone is insufficient. |
| UI-22 | P1 | Presentation mapping | `DetailPanel.tsx:165` | “Automated evidence”; “Qualification pending”; “Physical validation”; “Deferred / not completed”; “Persistent data root.” | Use scoped labels: **Automated checks passed**, **Not yet tested by Portcove on {platform}**, **Hands-on test completed**, **Hands-on test not completed**, **Saves and settings folder**, and **Created in your Portcove library**. Avoid an unqualified “Not yet tested.” |
| UI-23 | P2 | Copy only | `DetailPanel.tsx:166` | “Portcove resolves releases from this reviewed upstream.” | Present structured fields instead: **Release source: {project name}** and **Download check: Matches the SHA-256 recorded in the Portcove catalog**. Avoid implying a code, security, or quality review that did not occur. |
| UI-24 | P2 | Copy only | `DetailPanel.tsx:185-194` | “Choose or paste the folder or ZIP containing the required sources”; fragments such as “Referenced in place; never uploaded.” | “Choose the folder or ZIP file that contains the required game files.” “Portcove checks this location without uploading or changing it.” For one file: “Portcove uses this file in place and never uploads or changes it.” Apply equivalent complete-sentence variants to multi-disc and single-file requirements. |
| UI-25 | P2 | Copy only | `DetailPanel.tsx:201,207` | “Register every required source…”; “Choose required source.” | “Add all required game files before playing.”; “Add all required game files before installing.”; button **Choose game files**. Use **Add game files** only when the action saves an already selected match. Do not use “Add required source.” |
| UI-26 | P1 | Presentation mapping | `DetailPanel.tsx:215-236` | “Includes verified runtime”; “Verified local release”; “Use verified release”; “Unverified copy blocks install”; “Reuse retained release.” | Name the actual state: **Required component included**, **Download already checked**, **Use downloaded release**, **Remove or replace the local copy that does not match**, and **Use previous downloaded release**. Prefer an exact component name over “runtime.” |
| UI-27 | P2 | Copy only | `DetailPanel.tsx:243-249` | `Check update`, `Verify`, `Rollback`; tooltip “Create a versioned snapshot of persistent data.” | **Check for updates**, **Verify installation**, **Restore previous version**; tooltip **Back up saves and settings**. Keep `rollback` as the CLI command. |
| UI-28 | P1 | Interaction design | `DetailPanel.tsx:266-270` | “Verified runtime required”; “unlock Play”; “upstream setup”; “active version.” | Apply the readiness model. Prefer **Update required before playing**, “Install the available update that includes the required component,” **Game files required**, “Run the port’s setup before playing for the first time,” and **Ready to play**. Do not expose a generic runtime concept unless the user must manage it. |

### Catalog trust and updates

| ID | Priority | Change type | Path | Current wording or behavior | Final recommendation |
|---|---|---|---|---|---|
| UI-29 | P1 | Presentation mapping | `apps/desktop/src/components/CatalogUpdates.tsx:24-27,82-86,106` | Raw fallback reasons; “verify with them”; “No publishers configured”; “Remove trust”; grammar error such as “1 ports change.” | Map every reason code to a friendly summary with expandable technical details. Use “Verify the publisher key through a trusted channel,” **No trusted publishers**, **Stop trusting**, and true count-aware variants: “1 port will change” / “{n} ports will change.” |
| UI-30 | P1 | Interaction design | Catalog update review | The interface compresses signature, publisher trust, sequence protection, and port changes into generic trust language. | Show separate facts: **Catalog signature valid**, **Signed by {publisher}**, **Publisher trusted / not trusted**, **Sequence accepted / rejected**, and a human-readable change summary. The final action should name the outcome, such as **Apply catalog update**. |

### Library restore, move, discovery, and copy flows

| ID | Priority | Change type | Path | Current wording or behavior | Final recommendation |
|---|---|---|---|---|---|
| UI-31 | P1 | Interaction design | `apps/desktop/src/components/LibraryImport.tsx:35-43` | “LIBRARY BACKUP”; dense “Restore a trusted metadata export…”; placeholder exposes directory layout. | Use **RESTORE PORTCOVE LIBRARY** for the desktop task while retaining `library import` in the CLI. “Restore a Portcove export and its copied library data into this empty library. Portcove checks the copy before opening it and does not change the export.” Placeholder: “Folder containing the exported Portcove library.” Include a trust warning and review summary. |
| UI-32 | P1 | Interaction design | `apps/desktop/src/components/LibraryMove.tsx:61,77-79` | “Resume” and “Abort”; raw tree kinds; “source references keep their existing paths.” | Use outcome labels: **Resume move** and **Keep using original library**. Explain: “Resume the move to check the new copy and finish switching libraries.” “Keep using the original library. This option is available only before the new copy is activated.” “Neither option deletes the copied files.” Map tree kinds to display labels and say “{count-aware saved-path label} will stay unchanged.” |
| UI-33 | P1 | Interaction design | `apps/desktop/src/components/SourceDiscovery.tsx:38-53` | “Choose a source profile”; “plausible files”; “Checked {entries} entries and hashed {bytes}”; raw limit keys. | Heading/action: **Choose game files**. Intro: “Portcove searches only the folders you choose, checks possible matches, and lets you add an exact match. Nothing is uploaded or moved.” Result: “Found {n} exact matches. Checked {entries} files and folders ({size}).” Put file/depth/size/verification limits in advanced details with approved labels. |
| UI-34 | P2 | Copy only | `apps/desktop/src/components/OperationCancellation.tsx:19` | “Waiting for the current preparation step to stop safely.” | “Cancellation requested. Portcove will stop after the current step reaches a safe stopping point.” Do not imply it has already stopped. |
| UI-35 | P2 | Accessibility | `apps/desktop/src/components/ui.tsx:44`; `Chrome.tsx:33,50`; `use-command-surface.ts:22-28` | “D-pad / stick / arrows: move”; hard-coded `Ctrl`; universal “A” confirmation. | “D-pad, stick, or arrow keys: Move”; “Enter: Select” for keyboard. Show `Ctrl` on Windows/Linux and `⌘` on macOS. When possible, show glyphs for the active controller; otherwise say **Confirm button**, not universally “A.” |
| UI-36 | P1 | Copy only | `apps/desktop/src/use-command-surface.ts:24,29` | “Find a port by title, adapter, or platform”; “Return to the last played port” opens details only. | “Find a port by title, build method, or platform” only if build method is truly searchable and user-visible; otherwise “Find a port by title or platform.” “Open the last played port.” |
| UI-37 | P2 | Copy only | `apps/desktop/src/file-picker.ts:15,24` | “Original game source”; “ZIP source set.” | **Original game file**; **ZIP file containing required game files**. |
| UI-38 | P2 | Copy only | `apps/desktop/src/components/UpdateCenter.tsx:143` | “Removed source reference.” | **Removed saved game-file location** or **Removed game file**, depending on whether Portcove removed only the record or also removed a Portcove-owned copy. The activity wording must reflect the actual mutation. |
| UI-39 | P1 | Interaction design | `apps/desktop/src/components/AdoptionModal.tsx:11-28`; `use-command-surface.ts:27` | “SAFE ADOPTION”; “Bring an existing install into Portcove”; raw detected port IDs; “skipped entries”; “Adopting…” | Use **COPY EXISTING INSTALLATION**, “Add an existing installation to Portcove,” and “Portcove checks the folder, identifies the port, and copies supported application files into your library without changing the original.” Show port name with ID in details, “{n} unsupported items will remain only in the original folder,” and **Copying…**. Keep `adopt` only as the CLI command. |

### Backups, update center, activity, and progress

| ID | Priority | Change type | Path | Current wording or behavior | Final recommendation |
|---|---|---|---|---|---|
| UI-40 | P2 | Presentation mapping | `apps/desktop/src/components/BackupHistory.tsx:16-27` | Feature alternates between “Data backups” and “snapshots”; checksum prefix always shown. | Use **Backups** as the feature name unless the payload is guaranteed to contain only save data. Explain contents explicitly, such as “Backups include saves and settings.” Use “No backups yet” and count-aware “1 verified backup” / “{n} verified backups.” Put checksum details behind **Technical details**. |
| UI-41 | P1 | Interaction design | `apps/desktop/src/components/UpdateCenter.tsx:35-40` | “Apply update policies”; one action may report, download, or activate updates. | Separate **Save update settings** from executing those settings. If immediate side effects cannot be separated, show a review step that names them: “This will download updates for 2 ports and install 1 update.” Final button: **Continue with 3 changes**, **Download 2 updates**, or another dynamically accurate outcome. Do not hide downloads or installations behind “Apply settings.” |
| UI-42 | P2 | Copy only | `UpdateCenter.tsx:40` | “Install or adopt a port first…”; jargon-heavy empty state. | “Install a port or copy in an existing installation first. Portcove will then show its update channel, update setting, latest available release, and previous installed version here.” |
| UI-43 | P2 | Copy only | `UpdateCenter.tsx:75-78` | “SHARED LEDGER”; “operations”; “No operations recorded yet.” | **ACTIVITY HISTORY**; “Activity from the CLI and desktop appears here.”; “No activity yet.” |
| UI-44 | P2 | Presentation mapping | `UpdateCenter.tsx:128-150` | “Backed up data”; “Adopted installation”; “Removed managed files”; “Registered source”; and similar internal labels. | Use action-consistent labels: **Created backup**, **Copied existing installation**, **Removed installed versions**, **Removed saved game-file location**, **Added game file**, and **Searched for game files**. Reflect the actual mutation rather than applying one generic source phrase. |
| UI-45 | P1 | Presentation mapping | `UpdateCenter.tsx:93-100,122-125,165-178` | Raw target IDs; lowercase machine statuses `succeeded`, `failed`, `unfinished`, `running`; stale work labeled only “unfinished.” | Resolve targets to names. Map statuses to **Completed**, **Failed**, **May have been interrupted**, and **In progress**. Stale message: “This task has not reported completion. Review its details before retrying.” IDs remain in details. |
| UI-46 | P1 | Presentation mapping | `apps/desktop/src/components/Chrome.tsx:91-114`; `use-portcove.ts:104-273` | Progress labels come from raw enum formatting; secondary text is “Working…” or an unlabeled count. | Use a shared operation/phase map and attach units: “Downloading release — 24.3 MiB of 80.0 MiB,” “Checking installed ports — 3 of 12 ports,” or a task-specific indeterminate label. Screen-reader announcements should occur only on meaningful phase changes. |
| UI-47 | P2 | Presentation mapping | `apps/desktop/src/App.tsx:53-56,196`; `Chrome.tsx:212-217` | Raw error-detail keys and source-profile IDs; “Source profile {id} is not in the current catalog.” | Place raw fields under **Technical details** and map known fields to readable labels. Primary message: “The saved game-file requirement {label} is no longer present in the current catalog. Update the catalog or remove the saved location.” Show the ID only in details. |

## 3. Native desktop confirmations and recovery reviews

| ID | Priority | Change type | Path | Final recommendation | Rationale |
|---|---|---|---|---|---|
| DLG-01 | P1 | Interaction design | `apps/desktop/src-tauri/src/lib.rs:328-335` | “Restore the {formatted date} backup for {port name}? Portcove will first create a safety backup of the current saves and settings.” Put backup and port IDs in details only. | A destructive choice should use recognizable names and explain the safety step. |
| DLG-02 | P1 | Copy only | `lib.rs:372-378` | “Delete the backup from {formatted date} for {port name}? This cannot be undone.” Buttons: **Keep backup** and **Delete backup**. | UUIDs are not useful confirmation identifiers. |
| DLG-03 | P1 | Interaction design | `lib.rs:691-705` | “Remove {game-file label} from Portcove? {affected port names or count} will require it again before they can be installed or played. Portcove will not delete or change the original file.” Buttons: **Keep game file** and **Remove from Portcove**. | Converts dependency-graph language into consequences and a clear mutation boundary. |
| DLG-04 | P1 | Interaction design | `lib.rs:889-896` | “Copy {pluralized file count} ({formatted size}) into Portcove? {pluralized unsupported-item count} will remain only in the original folder. Portcove will not change the original.” Show the skipped/unsupported items in expandable details. | Defines what will and will not be copied and makes size legible. |
| DLG-05 | P1 | Interaction design | `lib.rs:922-938` | “Remove {pluralized installed-version-folder count} for {port name}? Saves and settings in {path} will be kept.” Mention mods only when the storage contract proves they are preserved. Buttons: **Keep installed versions** and **Remove installed versions**. | Uses the player’s model of installed files and avoids an unsupported preservation promise. |
| DLG-06 | P1 | Interaction design | `apps/desktop/src-tauri/src/library_transfer.rs:34-42` | “Restore {pluralized installed-version count} and local library data from {source} into {destination}? Continue only with an export you trust. Portcove will not change the source files.” Declining should return **Restore cancelled** without error styling. | Fixes grammar, makes the trust boundary explicit, and treats Cancel as expected behavior. |
| DLG-07 | P1 | Interaction design | Complex library move/import recovery dialogs | Use a custom review modal rather than a compact native yes/no dialog when the decision contains several paths, affected items, or recovery conditions. Include **What will change**, **What will be kept**, **Source**, **Destination**, **Affected ports**, and **Technical details**. | Some safety problems cannot be solved by replacing a sentence inside an undersized confirmation. |

## 4. CLI help, prompts, and human output

### Default help organization

Group commands in the default help view instead of presenting everyday tasks, recovery tools, catalog security, and integration endpoints as one undifferentiated list.

**Everyday commands**  
`install`, `update`, `exec`, `verify`, `remove`, `status`

**Game files and library**  
`source`, `backup`, `library`, `storage`

**Updates and recovery**  
`check`, `activate`, `rollback`, `cancel`, `activity`, `doctor`

**Advanced and integration**  
`catalog`, `auth`, `plan`, `ensure`, `reconcile`, `channel`, `policy`, `paths`, `capabilities`, `schema`, `about`

### Final command descriptions

Use these one-line descriptions in `crates/portcove-cli/src/main.rs:50-126` and `crates/portcove-cli/src/catalog.rs:28-67`:

| Command | Final help text |
|---|---|
| `library` | Export, restore, move, or recover a Portcove library. |
| `auth` | Sign in to GitHub or manage a personal access token. |
| `backup` | Create, list, restore, or delete backups of saves and settings. |
| `catalog` | List ports and manage signed catalog updates. |
| `source` | Add, find, check, relink, or remove original game files. |
| `status` | Show whether ports are installed, ready to play, and up to date. |
| `activity` | Show recent Portcove activity. |
| `cancel` | Stop a running task at the next safe stopping point. |
| `storage` | Show the Portcove library path and available disk space. |
| `doctor` | Check library health and optional tools without making changes. |
| `about` | Show the Portcove version, repository, and license. |
| `plan` | Preview installation steps and required game files without changing the library. |
| `paths` | Show the library paths for one port. |
| `check` | Check one or all installed ports for available updates. |
| `reconcile` | Carry out each port’s saved update setting. |
| `install` | Install one port from its configured release source. |
| `adopt` | Copy an existing supported installation into the Portcove library. |
| `ensure` | Install a port only when it is not already installed. |
| `update` | Update one or all installed ports. |
| `verify` | Check that installed application files still match the installed version. |
| `activate` | Finish installing a downloaded update. |
| `rollback` | Restore the previous installed version. |
| `remove` | Remove installed application versions while keeping saves and settings. |
| `channel` | Set a port’s upstream release channel. |
| `policy` | Set how a port handles available updates. |
| `exec` | Launch an installed port and pass the remaining arguments to the game. |
| `capabilities` | Show machine-readable CLI capabilities. |
| `schema` | Export JSON schemas for integrations. |
| `catalog list` | List all ports in the active catalog. |
| `catalog export` | Export the complete active catalog document. |
| `catalog show` | Show one port definition. |
| `catalog status` | Show the active catalog, trusted publisher keys, signature status, and rollback protection. |
| `catalog trust-key` | Trust a publisher by its 64-character Ed25519 public key. |
| `catalog revoke-key` | Stop trusting a publisher key. |
| `catalog update` | Preview a signed catalog update, or apply the exact plan returned by the preview. |
| `catalog rollback` | Restore the previous accepted signed catalog. |
| `catalog use-cached` | Use the cached accepted signed catalog. |
| `catalog use-embedded` | Use the catalog built into this Portcove version. |

### CLI findings

| ID | Priority | Change type | Path | Final recommendation |
|---|---|---|---|---|
| CLI-01 | P2 | Copy only | `crates/portcove-cli/src/main.rs:31-32` | Main description: “Manage native game ports from a local Portcove library.” Keep “Native ports. Checked downloads. Local game files.” as an optional short tagline only if each claim is accurate. Avoid “verified native PC ports.” |
| CLI-02 | P1 | Copy only | `main.rs:35-44` and argument structs | Give every consequential argument concrete help. Minimum wording: `--library` “Use this Portcove library instead of the default.”; `--json` “Write one JSON response to standard output.”; `--jsonl` “Stream JSON Lines progress events and a final result.”; `--non-interactive` “Do not prompt. Commands that require confirmation fail unless --yes is supplied.”; `-v` “Increase diagnostic logging; use -vv for more detail.”; `PORT_ID` “Catalog port ID; run ‘portcove catalog list’.”; `--stage` “Download and check the update without installing it.”; `--yes` “Confirm the reviewed action without prompting.”; `--expected-*` “Apply only the exact plan, state, or hash returned by the preview.”; `game_args` “Arguments passed unchanged to the game.” Add equivalent help to every remaining field. |
| CLI-03 | P1 | Copy only | `main.rs:166-208` | Rewrite safety-sensitive import, move, recovery, source discovery, and relink help around outcomes: “Preview or restore an export into a new or empty --library directory”; “Keep an interrupted restore closed and retain copied files”; “Preview or move a library after checking the new copy”; “Return to the original library before the new copy is activated”; “Search only the selected folders for exact game-file matches; do not add matches automatically”; “Check a new game-file path, then apply the exact plan returned by the preview.” |
| CLI-04 | P2 | Copy only | `main.rs:588` | “GitHub sign-in was cancelled before it finished.” |
| CLI-05 | P1 | Copy only | `main.rs:794-799` | “These installed ports will require the game file again: {display names with IDs}.” Prompt: “Remove {game-file label} from Portcove? The original file will not be deleted or changed.” |
| CLI-06 | P2 | Copy only | `main.rs:782,878,904,970` | “Provide PROFILE_ID or pass --all.”; “Provide PORT_ID or pass --all.” Preserve exact argument names because this is CLI guidance. |
| CLI-07 | P1 | Copy only | `main.rs:997` | “Remove all installed application versions for {port name} ({port_id})? Saves and settings will be kept.” Do not promise mod preservation unless guaranteed. |
| CLI-08 | P2 | Copy only | `main.rs:1050` | “The exec command cannot use --json or --jsonl because the game inherits standard input, standard output, standard error, and its own exit code.” |
| CLI-09 | P2 | Copy only | `main.rs:1129,1170` | “To apply this restore/move, pass the --expected-plan value returned by the preview.” Use the specific task name in each command. |
| CLI-10 | P2 | Copy only | `main.rs:1376` | “With --non-interactive, auth set-token requires --stdin. You can also set PORTCOVE_GITHUB_TOKEN.” |
| CLI-11 | P3 | Copy only | `main.rs:1392` | “Open {url} and enter code {code} to sign in to GitHub.” |
| CLI-12 | P1 | Presentation mapping | `main.rs:1518-1528` | Use human-readable sizes, names plus IDs, and a shared phase map: “Downloading {asset}: {done} of {total}”; “Checking {port name} ({port_id}) for updates”; “Downloading PlayStation build tools.” Never format raw enum names mechanically. |
| CLI-13 | P2 | Copy only | `main.rs:1580,1605,1614` | Standard human error shape: `Error: {summary}` followed by `Next step: {action}` when available. “Confirmation is required; pass --yes to continue.” “Operation cancelled.” Cancellation should not be styled as a failure unless cancellation itself failed. |
| CLI-14 | P1 | Interaction design | `crates/portcove-cli/src/human.rs:343-390` | Add command-specific summaries for install, update, ensure, adopt, backup, source, cancellation, catalog, restore/import, and move results. Keep the complete generic field document in JSON/JSONL or behind an explicit details/verbose option. |
| CLI-15 | P1 | Presentation mapping | `human.rs:45` | “GitHub requests: {remaining}/{limit} (resets {ISO-8601 timestamp with offset}).” |
| CLI-16 | P2 | Presentation mapping | `human.rs:77,114-117,137-139,197-200` | “Support tier”; source display label followed by ID; timestamps labeled **Created**, **Started**, **Finished**, or **Expires** and formatted with an explicit offset. |
| CLI-17 | P2 | Copy only | `human.rs:149,234` | “The active catalog contains no ports.”; “Repair review: no repairs needed.” |
| CLI-18 | P2 | Presentation mapping | `human.rs:302,319` | Use **Required component** or the component’s name; **Required game files**; **Saves and settings**. |
| CLI-19 | P1 | Copy only | `human.rs:474,486,531-532` | “Setup is required before first launch”; “Update required before playing; run `portcove update <port-id>`”; “Blocked by a local installation that does not match the expected files”; “Download the catalog release.” Include the precise recovery command. |
| CLI-20 | P2 | Presentation mapping | `human.rs:502-505` | Render Windows (x64), Linux (x64), macOS (Intel), and macOS (Apple silicon). Keep enum values in structured modes. |
| CLI-21 | P2 | Copy only | `crates/portcove-cli/src/catalog.rs:34-47,113` | “Active catalog”; “rollback and replay protection”; “64-character Ed25519 public key”; “Apply requires the fingerprint returned by the preview”; “Verify the publisher key through a trusted channel before trusting it.” Keep *replay* in this advanced security command, but explain the workflow. |
| CLI-22 | P2 | Presentation mapping | All primary human tables | Render operational entities as `Display name (id)`, not raw IDs alone and not names alone. Allow an `--ids-only` or structured mode where useful. | 
| CLI-23 | P1 | Presentation mapping | Source-check and source-discovery output | Show exact requirement label, selected path, match state, expected SHA-256, calculated SHA-256, and a direct next action. Do not hide full hashes in this workflow. |
| CLI-24 | P2 | Accessibility | Progress output in interactive terminals and redirected output | Use stable line-oriented output when stdout is not a TTY; avoid control sequences and rapidly changing counters in logs. Preserve JSONL as the integration-safe progress format. |

## 5. Core errors and progress surfaced to users

These recommendations apply to the human presentation layer defined in SYS-01. The current implementation strings may remain as technical details where they are useful for support. Each summary should be paired with a stable code, structured context, and a recovery action when one exists.

| ID | Priority | Change type | Path | Final user-facing summary or behavior |
|---|---|---|---|---|
| ERR-01 | P1 | Error architecture | `crates/portcove-core/src/cancellation.rs:75,190` | “This task is already being cancelled or has finished.”; “This task can no longer be cancelled because it is already finishing or complete.” |
| ERR-02 | P1 | Error architecture | `catalog_store.rs:185`; `catalog_update.rs:128`; `signed_catalog.rs:135` | “The previous catalog is older than the minimum version Portcove can safely accept.”; “Portcove rejected this catalog because its sequence was already accepted or is older than the accepted sequence.”; “The signed catalog has an invalid validity period, is dated in the future, or has expired.” Put replay-floor and sequence values in technical details. |
| ERR-03 | P1 | Error architecture | `database.rs:216,228,240` | “This library was created by a newer version of Portcove. Update Portcove before opening it.”; “Portcove found an incomplete library upgrade. Keep the library unchanged and retry with the same or a newer Portcove version.” Include the current and required schema versions in details. |
| ERR-04 | P1 | Copy only | `library.rs:251` | “{target} is in use by another Portcove process. Finish or close that task, then try again.” |
| ERR-05 | P1 | Error architecture | `service.rs:1226,1322,1349,1706,1736` | “The required game file for {requirement label} has not been added.”; “This game file has changed since it was added. Restore the original file or choose the correct file again: {path}.”; “{port name} requires {requirement label}. Pass --source <path> or add it with `portcove source add {id} <path>`.” |
| ERR-06 | P1 | Copy only | `service.rs:1986,1990` | “Portcove could not identify a supported installation in this folder. Pass --port <port-id> to choose one.”; “This folder matches more than one port: {names with IDs}. Pass --port <port-id> to choose one.” |
| ERR-07 | P2 | Copy only | `service.rs:2167` | “Installed versions changed after the removal preview. Review the removal again.” |
| ERR-08 | P1 | Error architecture | `service.rs:2607` | “A backup restore for {port name} is incomplete. Finish recovery before playing or creating another backup.” Provide a direct recovery action or command. |
| ERR-09 | P1 | Copy only | `runtime.rs:164` | Prefer: “An update is required before this port can be launched.” If the component must be exposed: “This port is missing the required {component name}. Update the port before launching.” |
| ERR-10 | P1 | Error architecture | `archive.rs:156,166` | “There is not enough free space to extract this release. Free space on {volume} and try again.”; “This archive contains filenames Portcove cannot use safely across its supported operating systems.” Put the exact filename and Unicode rationale in details. |
| ERR-11 | P1 | Copy only | `path.rs:74`; `adapter.rs:1168`; `service.rs:653,2815` | “This path contains characters Portcove cannot save or pass to the port safely. Choose a path that uses valid Unicode characters.” Remove the unexplained “Portcove V1” prefix. |
| ERR-12 | P1 | Error architecture | `source_discovery.rs:123`; `source_file.rs:18` | “Choose 1–8 folders and 1–256 game-file requirements. Search limits must be positive and within their allowed ranges.”; “The search reached its file-checking limit. Choose a smaller folder or increase --max-hash-bytes.” Include the actual and allowed values in details. |
| ERR-13 | P1 | Error architecture | `adapter.rs` materialization, runtime-source, setup-marker, private-staging, and integrity branches | Use task summaries based on the failed operation: “Portcove could not prepare the required game files.”; “The port’s first-run setup did not finish.”; “Portcove could not check the prepared game files.” Put exact paths, markers, adapter IDs, and internal state in details. |
| ERR-14 | P1 | Error architecture | `stfs.rs` | “The selected Xbox Live Arcade package is invalid, incomplete, or too large.” Keep `STFS` and the exact failing field in technical details. |
| ERR-15 | P1 | Copy only | `release.rs:297,343,397` | “This version of Portcove does not support GitHub device sign-in. Use PORTCOVE_GITHUB_TOKEN or continue anonymously.” Standardize advanced wording on **device sign-in session**. |
| ERR-16 | P1 | Error architecture | `service.rs:3122` | “GitHub’s request limit has been reached. Try again after {formatted reset time}, or sign in for a higher limit.” Use “release service” only when the provider is not GitHub. |
| ERR-17 | P2 | Error architecture | `gitlab.rs:105`; `release.rs:451`; catalog-update HTTP paths | “{service} returned HTTP {status} while {operation}.” Put the URL host, response body excerpt, request ID, and retry metadata in technical details when safe. |
| ERR-18 | P1 | Error architecture | `authorization.rs`, `database.rs`, `import_journal.rs`, `transfer_journal.rs`, recovery internals | “Portcove found an internal library-state error and stopped the task. Review recovery status before retrying, and include the technical details when requesting support.” Add “No files were changed” only when the recorded mutation boundary proves it. Never make this a generic invariant-error promise. |
| ERR-19 | P2 | Presentation mapping | `install.rs:362,454`; `psx.rs:143` | “Building the native port from your exact-match PlayStation disc…”; “Download matches the expected SHA-256: {asset}”; “Downloading PlayStation build tools…” Use “PlayStation,” not mixed `PS1`/`Psx`, in standard UI. |
| ERR-20 | P1 | Error architecture | All partially mutating operations | Include a structured mutation state such as **not started**, **no changes made**, **changes committed**, **recovery required**, or **outcome unknown**. Render a user-facing statement only when supported by that state. | 

## 6. Game-file selection and exact-match experience

This flow should be treated as a first-class product experience rather than a technical source-record form. It is the correct place to show complete hashes because users may need to compare exact file identities.

### Required information

| Field | Example presentation |
|---|---|
| Game-file requirement | **Diddy Kong Racing (USA, Rev 1)** |
| Accepted input | **Nintendo 64 cartridge image** |
| Accepted formats | **`.z64`, `.n64`, or `.v64`**, if all are actually supported |
| Selected file | `Diddy Kong Racing.z64` |
| Match result | **Exact match**, **Doesn’t match**, or **Couldn’t check** |
| Expected SHA-256 | Full, copyable hash |
| Calculated SHA-256 | Full, copyable hash |
| Handling statement | “Checked in place. Portcove did not upload, move, or change this file.” |

### Exact-match state

> **Exact game-file match**  
> This file matches Diddy Kong Racing (USA, Rev 1).

Primary action: **Add game file**  
Secondary actions: **Copy hash**, **Choose a different file**

### Mismatch state

> **This game file doesn’t match**  
> Portcove expected Diddy Kong Racing (USA, Rev 1), but the selected file has a different SHA-256. It may be a different region, revision, modified dump, or different game. Portcove did not change the file.

Primary action: **Choose another file**  
Secondary actions: **Copy hash**, **View supported versions**, **Technical details**

### Check-failure state

> **Portcove couldn’t check this file**  
> {Plain-language reason and recovery action.}

Primary action should match the reason, such as **Try again**, **Choose another file**, **Allow access**, or **Free disk space**.

### UX requirements

- Do not shorten hashes to prefixes in this flow.
- Do not label mismatches as merely **Unverified**; distinguish a known mismatch from a check that could not complete.
- Show region, revision, prototype date, disc number, and serial where those values distinguish accepted inputs.
- For multi-file requirements, show one result per required file and a set-level status such as **3 of 4 exact matches**.
- Make expected and calculated hashes individually copyable and screen-reader labeled.
- Preserve matching metadata in JSON/JSONL for automation.
- Explain conversion only after identity is established: “Portcove will create a working CHD copy” is different from “Portcove will use this file in place.”

## 7. Embedded catalog labels, fields, and summaries

### Catalog data-model recommendation

Do not attempt to encode every characteristic into a freeform summary. Add or normalize structured fields for:

- **Upstream project**
- **Upstream state:** active, archived, unknown
- **Build method:** source port, static recompilation, reimplementation, other
- **Installation method:** prebuilt download, built locally, first-launch preparation
- **Required game files:** file type, region, revision, disc number, serial, accepted formats
- **Supported platforms**
- **Portcove test status by platform and release**
- **Release channel**
- **Support tier**
- **Release verification method**
- **Saves and settings behavior**

The detail view can then render these fields consistently. Freeform summaries should describe what the user gets in one sentence rather than repeat maturity, channel, hashes, or adapter implementation.

| ID | Priority | Change type | Path | Final recommendation |
|---|---|---|---|---|
| CAT-01 | P2 | Data model | `crates/portcove-core/catalog/catalog.json:4-75` | Standardize display qualifiers to a single convention such as `(USA, v1.0)`, `(USA, Rev 1)`, and `(North America, v1.0)`. Preserve exact ROM-database or upstream nomenclature separately when matching requires it. Verify canonical names before bulk replacement. |
| CAT-02 | P2 | Copy only | `catalog.json:13-14,23,40-43` | Use readable qualifiers: “Dinosaur Planet (December 2000 prototype)”; “Diddy Kong Racing (USA, Rev 1)”; “WWF WrestleMania 2000 (USA, v1.2).” Do not append the generic word “source” to every visible requirement label when the surrounding UI already identifies it as a game-file requirement. |
| CAT-03 | P2 | Copy only | `catalog.json:69,72-74` | “Spyro the Dragon disc for OpenPete (NTSC-U, SCUS-94228).” For Jak entries, keep “retail disc” in the visible label and move extractor validation into setup or technical details. |
| CAT-04 | P1 | Data model | Summary fields throughout `catalog.json` | Remove support tier, release channel, test status, checksum method, and setup implementation from summary prose when structured fields can represent them. This is a schema/presentation task, not only a copy edit. |
| CAT-05 | P2 | Copy only | General port summaries | Use one concise pattern appropriate to the entry: “A native version of {game} maintained by {project/team}.”; “A native version of {game} built through static recompilation.”; or “Builds a native version of {game} locally from your exact-match original disc.” Do not claim active maintenance when the upstream is archived. |
| CAT-06 | P2 | Copy only | HarbourMasters entries around `catalog.json:84-131` | “A native version of {game} from HarbourMasters.” Use “maintained by” only while the project is actively maintained. |
| CAT-07 | P2 | Copy only | PS1 recompilation entries throughout `catalog.json` | “Builds a native version of {game} locally from your exact-match original PlayStation disc.” Where multiple discs are required, name the set. |
| CAT-08 | P2 | Copy only | `catalog.json:198` and summaries beginning “Opt-in…” | Remove “opt-in”; installation and channel choice are already voluntary. Example: “A native recompilation of Diddy Kong Racing.” Display **Alpha support tier** and the selected release channel separately. |
| CAT-09 | P2 | Copy only | `catalog.json:237,570` | Replace “upstream portable mode/storage” with the observable behavior: “Keeps saves and settings in your Portcove library.” |
| CAT-10 | P1 | Copy only | `catalog.json:272,360` | Final Fantasy VII: “Builds a native version locally from your exact-match three-disc CHD set.” Twisted Metal 4: “Builds a native version locally from your exact-match original disc.” |
| CAT-11 | P2 | Product policy | `catalog.json:465` | Resolve the scope mismatch between “Pokémon Generation I” and a Red-only file requirement. If only Red is supported, say “A native Lua/LÖVE recreation of Pokémon Red.” If the recreation covers broader Generation I behavior, clarify why Pokémon Red is the required input. |
| CAT-12 | P1 | Copy only | `catalog.json:475,484` | Remove “Phase 2B.” Use “An early native Lua/LÖVE recreation of Pokémon Gold and Silver.” Put readiness/support tier in its own field. |
| CAT-13 | P2 | Copy only | `catalog.json:502` | “A native Windows recompilation of the Xbox Live Arcade version of Castlevania: Symphony of the Night.” |
| CAT-14 | P2 | Copy only | `catalog.json:602,612` | BattleShip: “A native Super Smash Bros. 64 port that prepares its required game assets on first launch.” G-Diffuser: “A native F-Zero X port that uses your exact-match cartridge, Expansion Kit disk, and 64DD IPL files.” |
| CAT-15 | P1 | Copy only | `catalog.json:626` | “An early native version of The Legend of Dragoon that checks the required North American discs during setup.” Confirm accepted region and revision labels against the actual hashes before publishing. |
| CAT-16 | P2 | Copy only | `catalog.json:683,735` | Replace “checksum-pinned direct upstream release” and “checksum-qualified direct upstream release” with a neutral summary. Render **Download matches catalog SHA-256** as a separate release-integrity field. |
| CAT-17 | P1 | Copy only | `catalog.json:746` | “A Windows recompilation of Paper Mario that keeps saves and settings with the installed release.” Display beta support/channel fields separately. |
| CAT-18 | P1 | Data model | All catalog summaries plus `DetailPanel.tsx:165` | Define **Support tier** as Portcove’s readiness/support classification and **Release channel** as the upstream stream selected for an installation. Do not let words such as stable, beta, alpha, or rolling ambiguously represent both. |
| CAT-19 | P2 | Copy governance | Game-file requirements | Use **user-provided original game files** in product and policy descriptions. Do not claim Portcove determines whether files were “lawfully obtained.” Legal guidance may state the user’s responsibility separately. |

## 8. Documentation

| ID | Priority | Change type | Path | Final recommendation |
|---|---|---|---|---|
| DOC-01 | P1 | Copy only | `README.md:9` | “Portcove installs, updates, launches, and restores previous versions of native game ports while keeping user-provided original game files on your device.” Avoid the broad claim “verified native PC ports.” |
| DOC-02 | P2 | Documentation structure | `README.md:11-15` | Move planning authority and tracker details to **Development and roadmap** near contributing material. Keep one roadmap link near the top. The opening screen should orient players first. |
| DOC-03 | P1 | Copy only | `README.md:17` | “Portcove refuses to install a downloadable release unless the catalog provides a SHA-256 value or checksum file and the downloaded file matches it.” This names the exact protection instead of saying the project is “verified.” |
| DOC-04 | P1 | Documentation structure | `README.md:21-49` | Rename to **What Portcove can do** and group into **For players**, **Library safety**, **Launcher integration**, and **Developer and integration support**. Move locks, schemas, journals, and identity internals to `docs/ARCHITECTURE.md`. |
| DOC-05 | P1 | Copy only | `README.md:23,30,36-42` | “Bulk checks continue when one port fails and report each result separately.”; “Portcove checks user-provided original game files in place and never uploads or changes them.”; “Cancellation stops only at recorded safe boundaries.”; consolidate internals as “Desktop and CLI tasks coordinate through the same library and can recover from interrupted work.” |
| DOC-06 | P2 | Copy only | `README.md:43,46-49` | “You can also paste paths manually.”; “Settings shows every missing game file or BIOS in one place.”; “The UI distinguishes automated checks from completed hands-on tests.” Split optional disc-tool discovery into its own paragraph. |
| DOC-07 | P3 | Copy only | `README.md:53` | **Prerequisites**. |
| DOC-08 | P2 | Copy only | `README.md:75` | “Test an unsigned installer in an isolated folder, launch the app, confirm that its window responds, and uninstall it cleanly.” |
| DOC-09 | P1 | Documentation structure | `README.md:116-120` | Split GitHub authentication into **Anonymous use**, **Personal access token**, and **Device sign-in**. Replace “bypass source ownership checks” with “Portcove will not bypass checks that require users to provide their own original game files.” |
| DOC-10 | P2 | Documentation structure | `README.md:128` | Move signed-catalog material before **License** under **Optional signed catalog updates**. |
| DOC-11 | P1 | Copy only | `docs/CLI.md:3` | “Human formatting does not affect the stable JSON or JSONL structure.” |
| DOC-12 | P2 | Copy only | `docs/CLI.md:36,46,52,60,114` | “GitHub request limit”; “Portcove polls GitHub at the required intervals, reports expiry or denial as structured errors, and lets you cancel with Ctrl-C.”; “reviewed repair plan” only when a user actually reviewed it; “managed PlayStation recompilation profiles”; “acknowledgement of the request.” |
| DOC-13 | P1 | Documentation structure | `docs/CLI.md:176-237` | Break into **Path rules**, **Export and restore**, **Move a library**, **Recover an interrupted transfer**, **Find and relink game files**, and **Cancel work safely**. Put commands, preconditions, mutation boundaries, and guarantees in separate bullets. |
| DOC-14 | P2 | Copy only | `docs/CLI.md:178` and matching errors | “Portcove requires paths stored in SQLite or JSON, or passed to child processes, to use valid Unicode.” Remove “Portcove V1.” |
| DOC-15 | P2 | Documentation structure | `docs/CLI.md:284,298,300,302` | Add one **Schema history** table with version, affected document, compatibility effect, and change. |
| DOC-16 | P1 | Documentation structure | `docs/RELEASING.md:25,41` | “Isolated silent-install, launch, responsiveness, clean-exit, and uninstall test.” Split Windows release rehearsal into numbered checks with expected evidence. |
| DOC-17 | P2 | Documentation structure | `docs/RELEASING.md:78,82` | Split into **Preflight**, **Build matrix**, **Publish**, and **Retain evidence**, with one outcome per step. |
| DOC-18 | P1 | Copy only | `docs/ROADMAP.md:45-46` | “Lock the exact release artifacts, upgrade paths, packaging, and signing requirements for every claimed platform. The release rehearsal must pass with no known release blockers.” |
| DOC-19 | P2 | Copy only | `docs/ROADMAP.md:55` | **Signed in-app updates**. |
| DOC-20 | P1 | Product policy | `SECURITY.md:8`; `docs/CATALOG.md:17,24` | Align both documents on: “Portcove does not resolve releases dynamically from archived upstream repositories. A retired project may be supported only through a manually maintained direct manifest that pins every allowed artifact by SHA-256.” Define who approves that manifest and how support is withdrawn. |
| DOC-21 | P1 | Copy only | `docs/SIGNED-CATALOG.md:46` | “It does not protect against a local attacker who rewrites the database. It also cannot restore a newer replay floor after a whole-database rollback or guarantee a trustworthy system clock.” |
| DOC-22 | P3 | Copy only | `docs/SIGNED-CATALOG.md:40` | “The application rereads…” |
| DOC-23 | P2 | Documentation structure | `docs/DEVELOPMENT-STORAGE.md:7,17,32` | “Verified to be disposable.” Split into **What preflight checks**, **When it stops**, and **How to override intentionally**. |
| DOC-24 | P2 | Copy only | `docs/CATALOG.md:18,20,31` | “Clearly defined requirements for user-provided original game files”; “how updates preserve saves and settings”; “release checking, required game files, saved-data behavior, and implementation notes.” Avoid claiming Portcove determines legal provenance. |
| DOC-25 | P2 | Copy only | `docs/PROJECT-GOVERNANCE.md:9`; `docs/README.md` | **Implementation-ready specifications**. |
| DOC-26 | P2 | Documentation structure | `docs/ARCHITECTURE.md` | Split the library model under **Database and migrations**, **Concurrency**, **Original game files**, **Saves and settings**, **Backups**, and **Library transfers**. |
| DOC-27 | P1 | Product policy | `docs/DESIGN-SYSTEM.md:16,44`; live UI | Update the live UI to follow result-naming controls and platform-aware shortcuts. Add definitions for **Support tier**, **Release channel**, **Portcove test status**, and every approved verification label. |
| DOC-28 | P3 | Copy governance | `docs/BRAND-ASSETS.md` | Do not rewrite quoted prompts, hashes, or generated-output records. Add new terminology guidance outside the preserved evidence. |
| DOC-29 | P2 | Documentation structure | New content-design section or `docs/DESIGN-SYSTEM.md` | Add the canonical vocabulary, verification table, readiness states, confirmation pattern, capitalization style, number/date/size rules, ID policy, and technical-details pattern from this audit. |

## 9. GitHub forms, application metadata, and maintainer scripts

| ID | Priority | Change type | Path | Final recommendation |
|---|---|---|---|---|
| OPS-01 | P2 | Copy only | `.github/ISSUE_TEMPLATE/engineering-work.yml:2` | “Propose implementation-ready product, engineering, documentation, security, or technical-debt work.” |
| OPS-02 | P2 | Copy only | `.github/ISSUE_TEMPLATE/engineering-work.yml:51`; `.github/pull_request_template.md:24` | “Describe the affected stable contract, user documentation, or release snapshot—or explain why none applies.” |
| OPS-03 | P2 | Copy only | `.github/ISSUE_TEMPLATE/new-port.yml:2` | “Suggest a new port for review and roadmap planning.” |
| OPS-04 | P2 | Copy only | `.github/ISSUE_TEMPLATE/new-port.yml:43-54` | **Required game files and setup**; **Release files and integrity checks**; **Launch, saves and settings, and implementation fit**. |
| OPS-05 | P2 | Copy only | `.github/ISSUE_TEMPLATE/qualification.yml` and platform labels | Use “controllers or hardware controls,” standard platform names, and **Portcove test status** in contributor-facing explanations. Maintainer data fields may retain `qualification` when they are clearly technical. |
| OPS-06 | P1 | Copy only | `apps/desktop/src-tauri/tauri.conf.json:40` | “A local-first app for installing, updating, launching, and restoring previous versions of native game ports while keeping original game files on your device.” Do not call the ports generically verified. |
| OPS-07 | P3 | Copy only | `apps/desktop/index.html:9` | “Manage native game ports from one local Portcove library.” |
| OPS-08 | P2 | Copy only | `scripts/check-fallow-report.mjs:23`, `repository-settings.mjs:142`, `roadmap.mjs:901,913,928`, `quality-tools.mjs:161`, and similar entry points | Use `Usage:` consistently and implement `--help` that prints command purpose, required arguments, options, and one example with exit code 0. |
| OPS-09 | P2 | Copy only | `scripts/sign-catalog.mjs:15,18,26,35` | “Input must be a regular file no larger than {limit}.”; “The input exceeded the {limit} size limit while being read.”; “--sequence must be a positive safe integer, and the validity period must be no more than 366 days; timestamps use Unix seconds.” |
| OPS-10 | P2 | Copy only | `scripts/roadmap.mjs:795,868-869` | “No mutable roadmap items are stored in the repository.” Split successful checks into separate lines. “Manual confirmation is required because GitHub does not provide a reliable API for reading these settings:” |
| OPS-11 | P3 | Copy only | `scripts/check-release-metadata.mjs:414` | “Release metadata passed for Portcove {version}{tag}. Checked {n} required files, {n} brand assets, and {n} model files.” Use true pluralization. |
| OPS-12 | P2 | Copy only | `scripts/check-retcomm-upstreams.mjs:76` | “Checked {n} direct PlayStation upstream repositories against {source}. RetComM-Launcher is not used as a release source.” |
| OPS-13 | P2 | Copy only | `scripts/package-local.ps1:13,62,78` | “The output directory resolves outside the Portcove workspace.”; “Choose a packaging directory inside, but not equal to, the workspace.”; “The source archive contains an item that must not be packaged: {entry}.” |
| OPS-14 | P2 | Copy only | `scripts/test-windows-installer.ps1:56` | “The installed app did not open a responsive Portcove window.” |
| OPS-15 | P2 | Copy only | `scripts/qualification-report.mjs:20,42` | “Provide an existing Portcove CLI executable and an initialized test library.”; “The CLI returned a report format this tool does not support.” Keep the technical term `qualification` in the script name if it is a stable maintainer contract. |
| OPS-16 | P2 | Copy only | `scripts/dev-storage.mjs:26,48,72,80,107,234-241,278-289,312` | “No existing parent directory was found for {path}.”; “--minimum-free-gib must be a positive number; received {value}.”; “Unknown action {action}. Use preflight, run, or clean.”; “Portcove will not clean through a symlink, junction, or non-directory: {path}.” Add a remedy to every refusal. |
| OPS-17 | P3 | Copy only | `scripts/quality-tools.mjs:25,33-48,106-122,141-161`; `scripts/bootstrap-quality-tools.ps1:83-96` | Use sentence-cased complete messages while retaining exact field names in backticks: “The quality manifest `schema_version` must be 1.”; “Duplicate or missing tool ID: {id}.”; “Unknown quality tool: {id}.”; “Could not install…” |
| OPS-18 | P2 | Copy only | `scripts/release-preflight.ps1` | Retain the exit code and add the failing command or report path: “Release metadata check failed with exit code {code}. See {log_or_report}.” |

## 10. Accessibility, localization, and responsive-copy requirements

These requirements should be added to the implementation plan even though they do not map to one existing string.

### Pluralization and formatting

Test all count-based messages with:

- zero items;
- one item;
- two items;
- large values;
- missing or unknown totals.

Desktop dates and numbers should use locale-aware formatters. CLI dates should use an unambiguous timestamp with an explicit UTC offset. Exact Unix values remain available in JSON/JSONL.

### Screen readers and status communication

- Do not announce every byte or item-count update. Announce phase changes and meaningful milestones.
- Do not expose all-caps visible text as an all-caps accessible name when it harms pronunciation.
- Do not rely on color alone for **Exact match**, **Doesn’t match**, **Needs review**, **Failed**, or **Ready to play**.
- Ensure a visible **View details** control also has an accessible name that means “View details,” not “Play” or “Open options.”
- Label expected and calculated hashes distinctly for assistive technology.
- Ensure focus moves to the first actionable error or result after a check completes.

### Platform and input guidance

- Display `Ctrl` on Windows and Linux and `⌘` on macOS.
- Prefer glyphs for the last-used controller when available.
- Do not assume the confirmation button is always Xbox-style **A**.
- Keep keyboard, gamepad, and screen-reader guidance in sync with actual focus behavior.

### Responsive-copy testing

Test revised strings at:

- narrow desktop-window widths;
- 125%, 150%, and 200% display scaling;
- increased OS text size;
- long port, publisher, source, and project names;
- long localized dates and large byte values;
- Windows, macOS, and Linux system fonts;
- pseudolocalized text with approximately 30–40% expansion.

## 11. Surfaces reviewed with no wording change recommended

- `LICENSE-*`, `THIRD_PARTY_NOTICES.md`, dependency lockfiles, vendored metadata, binary models, icons, and generated image assets: legal, machine-owned, or non-textual content.
- Stable JSON/JSONL field names and enum values: changing these would be a compatibility change. Improve their human rendering instead.
- `docs/archive/**`: historical records already carry prominent notices that current GitHub Projects data or current documentation takes precedence. Preserving their original wording is more accurate than retroactive editing.
- `docs/AUDIT-REMEDIATION.md`, `docs/DEFERRED.md`, `docs/GUI-COMPETITIVE-REVIEW.md`, `docs/QUALITY.md`, `docs/REPOSITORY-SETTINGS.md`, `docs/THEME.md`, `docs/V1-CUTOFF.md`, and `docs/releases/README.md`: reviewed; no additional change is recommended beyond the cross-surface conventions above.
- Approved prompt and hash records in `docs/BRAND-ASSETS.md`: preserve as evidence, as noted in DOC-28.
- Test-only sample strings: update expectations only when implementing a production-copy change; do not treat fixtures as an independent public surface.
- Catalog IDs, source-profile IDs, key IDs, plan fingerprints, checksums, and UUIDs: keep exact values in machine output and technical details. The game-file exact-match flow is the deliberate exception where complete expected and calculated hashes should also be visible and copyable in the standard interface.

## 12. Definition of done and regression safeguards

Implementation is complete only when all of the following are true:

- No desktop text is generated by replacing underscores or hyphens in enum values.
- Every human-facing core error has a stable semantic code and structured context.
- Every blocking state provides a next action when a recovery action exists.
- No generic **Verified** status appears without identifying the checked object and property.
- Catalog signature, publisher trust, download digest, game-file digest, installation integrity, automated tests, and hands-on tests are represented separately.
- No parenthetical plurals such as `file(s)` appear in user-facing output.
- No raw UUID is the primary identifier in the desktop UI.
- CLI human output shows display names and operational IDs together where IDs are needed.
- Desktop dates are locale-aware; CLI dates are unambiguous; structured modes preserve exact values.
- The game-file matching flow shows full expected and calculated SHA-256 values.
- Every destructive or recovery review identifies what changes, what remains, whether originals are modified, and whether the action can be undone.
- Cancellation is represented as a neutral outcome unless cancellation itself fails.
- Unknown enum values use a safe fallback and preserve the raw value in technical details.
- Copy is tested with zero, singular, plural, unknown, long, and missing values.
- Progress is accessible and does not flood screen readers or noninteractive logs.
- Saving update settings does not silently download or install updates. Any immediate side effects receive an explicit review step.
- Preservation claims mention mods only when the implementation contract guarantees mod preservation.
- “No files were changed” appears only when a structured mutation result proves it.
- The archived-upstream policy is identical in `SECURITY.md`, `docs/CATALOG.md`, and catalog validation behavior.
- User-facing terminology lint and tests prevent prohibited internal terms from returning to standard UI strings.

## 13. Recommended implementation order

1. **Define the semantic model.** Finalize verification types, publisher trust, upstream state, support tier, release channel, Portcove test status, readiness states, game-file terminology, and preservation guarantees.
2. **Implement the shared presentation layer.** Add stable error codes, structured parameters, mutation states, typed recovery actions, display-name resolution, pluralization, date and size formatting, approved enum maps, and safe unknown-value handling.
3. **Redesign safety-critical flows.** Fix source selection, source removal, library restore, interrupted library move, backup restore/delete, installed-version removal, cancellation, and update-policy execution.
4. **Implement the game-file identity experience.** Show exact requirement names, accepted inputs, full expected and calculated SHA-256 values, exact-match/mismatch/check-failure states, and direct recovery actions.
5. **Normalize desktop readiness and information architecture.** Reorder the port detail view, simplify cards, implement canonical states and actions, improve progress, and move IDs and raw fields into technical details.
6. **Improve CLI discovery and human output.** Group commands, add all field help, render names with IDs, create command-specific summaries, and apply the structured error and progress model.
7. **Normalize catalog data.** Add structured build method, installation method, game-file requirement, platform, test-status, upstream-state, support-tier, channel, and integrity fields; then rewrite only the remaining freeform descriptions.
8. **Resolve public policy and restructure documentation.** Fix the archived-upstream contradiction, define verification claims, orient the README toward players, and split dense CLI/release procedures into executable task sections.
9. **Apply GitHub-form, metadata, maintainer-script, punctuation, and capitalization polish.**
10. **Run task-based usability and accessibility tests.** At minimum, test a wrong game revision, missing game files, an archived upstream, a downloaded update, an interrupted library move, source removal, backup restore/delete, exhausted GitHub requests, first-run setup, and a non-cancellable finishing task.

## Final assessment

The original audit correctly identifies implementation-language leakage as Portcove’s dominant copy problem. The final implementation should go one step further: it should define a coherent model of **what Portcove knows, what Portcove checked, what state the port is in, what will change, and what the user can safely do next**.

That model should drive desktop copy, CLI output, catalog fields, errors, progress, confirmations, documentation, and tests. Once it exists, most wording improvements can be implemented through shared rendering and structured data rather than hundreds of unrelated string replacements.

