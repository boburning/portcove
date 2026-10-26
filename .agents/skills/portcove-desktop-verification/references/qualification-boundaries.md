# Native qualification boundary checks

Read only the checks relevant to the selected native acceptance or harness change. These supplement the existing identity, isolation and evidence rules; lower-level tests do not replace actual native acceptance.

## Platform, preflight and input custody

For minimum-platform claims, retain the exact OS build/architecture, shipped
artifact and runtime identities, and the WebView engine actually loaded by that
artifact. Newer systems, compiler targets, build images and installed host
packages cannot establish the claimed baseline. Exercise native behavior and
insufficient-runtime handling on that baseline.

For restricted Windows preflights, resolve system names such as privilege LUIDs
before impersonation; query the actual reviewer token and protected metadata
under impersonation. Preserve refusal, reversion and teardown. Capture native
error codes at the failing call; uncaptured historical codes remain unknown.
Broker controls and inert fixtures do not establish reviewer startup acceptance.

For launch/readiness races, acquire the existing shared exclusion before checking
intent, including legacy paths with no intent, and retain it through teardown and
evidence capture. Exercise preparation, launch and recovery interleavings through
the real helpers with inert provider effects.

Before a native run, retain immutable copies of declared source/helper inputs
and verify their hashes against the receipt. Record compiled application identity
separately from the executed harness revision. Later checkout edits or
reconstructed bytes cannot replace missing capture; preserve failed evidence.

## Windows observation

If a native observer can continue after its deadline, retain its desktop/station
handles until bounded drain proves the observer has exited. Preserve the original
timeout and any incomplete drain as failed evidence. When changing observer
lifetime handling, exercise timeout and drain with a controlled slow observer.

When an owned window fails visibility checks, capture its style bits,
parent/desktop ancestry and observer context before further show attempts.
The window's own WS_VISIBLE flag alone does not establish IsWindowVisible success.
If an ancestor is hidden, preserve that diagnostic instead of repeating show
calls. Keep visibility, responsiveness and cleanup as separate outcomes; review
any station/desktop isolation change under the existing authority before execution.

## Harness coverage and consumers

When adding native regressions, inspect the required hosted Windows test owner and inventory before pushing. Prefer the cohesive existing suite that owns the behavior; otherwise wire the new suite explicitly and prove it executes on Windows rather than merely skips elsewhere.

When refactoring source-sliced harness tests, test actual host exports where
feasible and execute serialized browser callbacks in isolation. Retain the
original behavioral cases; an exported helper with a different responsibility
does not preserve that coverage.

If repository Node contracts consume a native fixture helper, inspect that consumer's actual dependency setup. Exercise its real import and pure helper behavior without native-driver packages, using an owned isolated child outside installed dependency ancestry and proving the package cannot resolve. Keep native-only imports at the existing dispatcher boundary, then qualify affected real native calls separately; preserve shared dependency state.

## Launch and retained profiles

For admitted source containers and user-prepared runtimes, test the actual launch representation boundary. Source integrity and registration do not prove runtime compatibility. Observe guidance, actual launch and return; if a raw original is required, use a separately authorized bounded copy and retain the archive/external tree without silently materializing into player-owned files.

Before reopening a retained profile with a different runtime, compare supported persistent-library schema and migration behavior as well as package/API compatibility. Preserve the compatible runtime for outstanding acceptance. Use a separately owned copy or fresh fixture for newer-runtime qualification; opening the original profile can irreversibly change its compatibility.

On Windows, remove every case alias of each isolation-sensitive variable from the actual child environment before setting its intended value. Preserve unrelated variables and test a real child with competing aliases before native execution; deleting only the uppercase spelling does not prove isolation.

## Current host and product effects

Before spawning a replacement owned host, invalidate former ephemeral driver identity, captured inventory and cleanup proof while retaining dated artifacts. Exercise spawn-success/identity-capture-failure; current quiescence requires current host bindings and positive root/descendant exit. An old cleanup receipt cannot attest a replacement, and harness exit proof does not write product recovery state.

When native dismissal or cancellation fails despite component tests, trace the real application callback through any identity/generation-sensitive mutation. Reproduce with that callback or an equivalent argument-sensitive contract and assert the meaningful state effect, not just invocation. Preserve native failures, obtain causal repair from the owner, and retain existing waits.

## WebView containment

Bind cancellation assertions to the actual engine contract. Distinguish preserved document context, emitted network requests and remote-response execution; do not infer one from another. Retain method/path/time/phase request evidence and use benign owned execution markers or beacons. Limit allowed traffic to the demonstrated contract and report unproved client attribution or unavailable privileged IPC after refused navigation; preserve the original failed assertion.

## Preparation before an inherited input journey

Within the selected bounded scenario, map every inherited selector to its current control owner, including unchanged setup and safety-review controls. Where a regression is feasible, consume the actual scenario selector/callback against the owning rendered component, proving no consent action beforehand and exactly the intended effect afterward. Do not broaden this check to an unrelated harness audit.

Enumerate every Desktop/CLI consumer of synthetic catalog/artifact fixtures and verify each selected build route enables the existing required qualification capability. After a feature-selection repair, use a bounded noninteractive parity control before separately admitted input. Preserve normal production refusal.

Trace the authoritative focus destination and exercise the actual serialized browser observer against that destination and negative disconnected, hidden, inert, disabled or unrelated states. Capture minimal focus identity at the existing wait boundary without an extra focus action or typed-text capture. Source controls cannot recover an unrecorded historical destination.

For parent-owned success replacement, require a regression that actually removes/rekeys the opener or ancestor through the application's success callback. Assert document.activeElement after React commit and the pinned dialog's queued cleanup, including owner/route replacement negatives. Keeping the opener mounted or checking only resolver return values leaves the existing replacement rule unenforced; the real cleanup regression is the proposed admission barrier, not another native retry.

## Retained evidence and shipping refusals

When reusing native evidence, retain the actual executed revision, binary hash and result. Compare relevant shipping, fixture, generated/catalog and dependency inputs; report bounded behavioral applicability separately from whole-binary equivalence. Matching changed source blobs alone cannot establish byte-identical later executables. Repeat only invalidated obligations under their existing admission contract.

Before a packaged refusal case, inspect the pinned runtime's actual shipping-profile branch and bind a known valid command/arguments. Require its specific enforcement refusal plus unchanged-state controls, rejecting malformed/unknown/unrelated errors. Debug-only diagnostics are not an ordinary-release requirement and do not justify enabling privileges or broad error matching.

## Failure detail custody

Bind diagnostics to the actual owning alert and its existing first-party redacted projection, including collapsed details. A bounded read of that projection must not open/copy UI or reinvoke mutations. Preserve the original operation failure across DOM, parse or evidence-write errors; register exclusively written artifacts only after successful persistence. State which fields the projection omits. Mounted/source validation is separate from proof that the native capture branch actually executed.
