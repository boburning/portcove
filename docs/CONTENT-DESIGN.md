# Content design

This is the writing contract for current Portcove documentation, human CLI
output and interface copy. The [glossary](../GLOSSARY.md) defines domain meanings;
the [design system](DESIGN-SYSTEM.md#public-beta-writing-and-terminology) owns
the delivered interface compositions and their specific labels. Core and the
relevant host contract own behavior. Wording must describe their actual facts
and limits without creating a new readiness, trust or recovery decision.

## Start with the player's task

Name the object and next action before implementation detail. Use “game” for
playing or managing saved data, “port” for an implementation or catalog entry,
and the precise file or installation when its identity matters. Use **Game
files**, **Saved file location**, **Saves and settings**, **File details**,
**Technical details** and **Test results** in their applicable contexts; they
are not interchangeable labels for one generic source or status.

Keep application, game-port, catalog and plugin updates distinct. A game update
does not update Portcove, and a catalog update changes definitions rather than
installing every game. Describe launch-only, external-registration and managed
lifecycle routes by the capabilities actually available. Named launchers or
projects belong beside scoped instructions and status, not an unqualified
compatibility claim. [Integration levels](INTEGRATIONS.md) retain their authority.

The general description is “Install, update, and play native game ports.”
Explain an individual route's limitations at its controls. Avoid promotional
claims such as “verified ports” or an implication that every port has automatic
installation, saved-data management or completed gameplay testing.

## Name the property checked

Use the object, checked property and relevant scope together. “Verified” or
“trusted” on its own is insufficient. These examples are permitted only when
the corresponding evidence exists:

| Evidence                                   | Precise wording                                                                                                                 | What it does not establish                                                                        |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Catalog signature and admitted key         | “Catalog signature checked with publisher key {fingerprint}.” Identify the active catalog/source and applicable trust decision. | Authenticity or safety of every executable, or authority beyond the admitted publisher/key role.  |
| Download digest comparison                 | “Downloaded file matches the expected SHA-256.” Identify the artifact and expected-digest provenance when relevant.             | Independent publisher trust, malware absence or a gameplay result.                                |
| Exact original-file profile match          | “Game file matches {named edition/profile}.” Retain the actual matched identity and full relevant hashes in File details.       | Ownership/legal provenance, all editions, another port's compatibility or future unchanged bytes. |
| Structural or upstream-validator check     | Name the structure or validator, its actual result and limitations.                                                             | An exact edition match when no exact identity was established.                                    |
| Saved-source baseline comparison           | “Game files are unchanged since they were saved.” State unavailable, changed or unchecked facts separately.                     | Stronger catalog evidence or permission to install/launch.                                        |
| Installed-file integrity check             | Name the checked installation and whether the result covers the full immutable manifest or the narrower launch-critical check.  | Save compatibility, a new release's integrity or all future launches.                             |
| Automated package/contract checks          | “Package checks passed on {platform/build}.” Show the selected artifact, method and scope in Test results.                      | Gameplay, physical-controller testing or a different package/platform.                            |
| Direct application or gameplay observation | Name the exact app/game operation, build, platform and method actually observed.                                                | Unperformed audio, saves, hardware or broader compatibility claims.                               |
| Successful process termination             | “Process exited.” Include a known exit result where useful.                                                                     | Successful gameplay or user comprehension.                                                        |
| Retained previous version or backup        | State the actual retained version/snapshot and checked content scope.                                                           | A completed restore, universal rollback availability or compatible saves.                         |

Preserve [signed-catalog limitations](SIGNED-CATALOG.md): local database attackers,
whole-database rollback of the replay floor and the system clock remain distinct
from signature verification. Application signing and updater trust follow
[their own contract](UPDATER-TRUST.md).

## Keep state dimensions separate

| Dimension                       | Presentation rule                                                                                                                                                              |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Catalog category / support tier | Describe the declaration using its current label; it is not a fresh readiness or qualification result.                                                                         |
| Game-port channel               | Display Stable / Preview / Rolling while retaining `stable` / `beta` / `rolling` in compatible machine commands and values.                                                    |
| Portcove test status            | Distinguish not tested, a scoped passed check and a scoped failed check. Retain artifact/platform/method/date limits.                                                          |
| Upstream origin or maintenance  | Keep official/community/local attribution and active/archived/retired maintenance facts separate from permission and quality.                                                  |
| Setup and launch readiness      | Present the supplied Core assessment for the selected route. Explain a mandatory refusal and its supported remedy; an optional unknown observation does not become a new hold. |
| Running work and recovery       | Distinguish requested, running, settled, partially completed, interrupted and unknown outcomes using authoritative facts.                                                      |

An empty list, an unavailable read and a successful check with no result are
different states. Do not turn a stale observation into a current check. Bulk
work reports each item's outcome and true totals; completion of the batch does
not mean every item succeeded. A successful mutation and failed subsequent
readback remain separate facts.

## Controls, confirmations and shortcuts

Controls name their immediate action and object. **Review installation** opens
a review; **Install** applies the reviewed action. **Copy launch command** must
copy an actual launch command, while a command with unresolved prerequisites
is a **command template**. A review label must not conceal immediate mutation.

Before a consequential action, show the exact target, what changes, what is
retained, required permissions/preconditions and the next supported recovery
route. Name originals, copied data, saved locations and installed versions
separately. Do not promise preservation of all saves, mods or files unless the
owning operation guarantees that scope. For example, removing a saved location
removes the registration; deleting managed installed versions is a different
action. Follow the operation's existing native/CLI consent route and fresh
fingerprint rules; wording introduces neither an extra approval nor a bypass.

Use the host's existing shortcut mapping: **Ctrl** on Windows/Linux and
**Command (⌘)** on macOS where that mapping is implemented. Cross-platform
documentation can say **Ctrl/Cmd+K** and explain the platform choice. Do not
invent shortcuts or display Windows keys as macOS instructions. Keep essential
actions accessible without remembering a shortcut. The current shell contract,
including editable/IME/dialog exclusions, remains in the design system.

## Results, cancellation and errors

Lead with the task and actual result, then retained state and a supported next
step. Use display names with stable IDs when identification matters. Say
“Review only; no changes applied” only for an actual read-only result. A
cancelled prompt can be neutral, but a stopped operation may have committed
changes or retained recovery files; describe those consequences explicitly.

For CLI human errors, the pattern is `Error: {safe summary}` followed by
`Next step: {supported action}` when one exists. For interface errors, keep the
same cause/outcome/remedy structure near the affected task. Preserve known
failure versus unavailable/unknown evidence. Do not manufacture a recovery
command, recommend blindly repeating a mutation, or describe unknown cleanup
as completed. Human formatting never changes JSON/JSONL codes, IDs, fields,
timestamps, byte counts or exit behavior; [the CLI contract](CLI.md) owns those.

Cancellation acknowledgment means a request was accepted, not that the operation
has stopped. Core's terminal result and authoritative status/activity readback
establish the outcome. Dismissing a notice does not cancel, resume or clean work.
When readback fails after a known mutation, retain the known result and identify
what could not be refreshed.

## Capitalization, numbers, dates and identifiers

- Use sentence case for headings, controls, statuses and summaries. Preserve
  Portcove, project names, platform names and literal command/schema identifiers.
- Use complete localized messages with named interpolation and real plural
  rules. Handle zero, one, many and unknown separately; never concatenate an
  English suffix or render unknown as zero. Follow [localization](LOCALIZATION.md).
- Use IEC units for human byte quantities, such as KiB, MiB and GiB, with useful
  precision. Name the counted object (files, ports, releases or bytes). A
  progress total of zero/unknown is not a fabricated percentage. Machine byte
  counts retain their exact integer contract.
- Label dates by meaning: **Created**, **Started**, **Finished**, **Expires** or
  **Resets**. Include an explicit offset/UTC designation when presenting an
  instant, particularly in CLI or comparable evidence. `Z` denotes UTC; a date
  alone does not identify an instant. Invalid or absent time is unknown, not
  epoch zero. Machine Unix timestamps and their units remain unchanged.
- Preserve operational IDs exactly. Where the audience needs an entity name,
  show `Display name (id)` or an equivalent labeled pair. A name, artwork ID or
  path is not a substitute for the library/port identity. Keep command placeholders
  recognizable, such as `PORT_ID`, and distinguish them from executable examples.
- Allow long names, Unicode paths and full required hashes to wrap and remain
  selectable/copyable. A shortened preview never replaces the full consequential
  value in review or detail. Do not mechanically prettify enum names into a
  product promise; use the owning explicit presentation mapping.

## Supporting details and evidence

**File details** explains selected/saved paths, file identity, expected and
calculated hashes and actual check scope. **Technical details** carries the
relevant command, structured code, operational IDs or retained report for
diagnosis. **Test results** describes qualification method, artifact, environment
and result. Essential consequences and remedies remain visible before opening
a disclosure. Never reveal credentials or unrestricted private/raw errors just
because a section is called Technical details; use the existing redaction and
sharing boundaries.

Documentation examples name the build/artifact/environment when behavior differs
between releases. Authentic media keeps its original provenance and limits;
a mockup is labeled as such. Preserve quoted prompts, legal text, hashes and
generated provenance records verbatim; new terminology guidance belongs outside
those records. Stable docs describe shipped behavior; an explicitly labeled ADR
can record a future decision without presenting it as an implemented command.

## Review a changed task path

Read the complete entry → review → result → recovery route in rendered form,
including links and long values. Verify claims against the owning source and
existing meaningful tests/evidence. Check unknown, zero/one/many, partial,
failure, cancellation and retained-state wording where the task exposes them.
Preserve machine contracts and source/checksum/archive/symlink/persistence/lock/
activation/rollback/credential/process trust boundaries.

Use current [quality](QUALITY.md) and [contribution](CONTRIBUTION-CONVENTIONS.md)
rules for applicable review and required hosted validation. This contract adds
no separate native, human-comprehension or gameplay gate; claim those observations
only when actually established within the owning acceptance.
