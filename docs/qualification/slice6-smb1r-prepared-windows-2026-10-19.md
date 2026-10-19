# Super Mario Bros. Remastered: limited Windows vanilla route

Fixed slice 6B, owner #520 under #136, October 19, 2026. Core registers the
authenticated stock runtime in place, verifies the separately registered original,
and checks the current account's shared game-data boundary before launch. External
files remain user owned. Repository admission, private operation acceptance,
installed Desktop observations and protected production publication are distinct.

## Frozen artifact and original

Upstream is `JHDev2006/Super-Mario-Bros.-Remastered-Public`, source
`f379a3257ef1cf89cf4bf911f40c9262447da2c6`, tag `1.1-stable`.
Official Windows asset 544508287, `Windows.zip`, is 76,214,255 bytes,
SHA256 `164f5160b7b73f161b956fa1470813c8e21fa92424f94c8889de46111a59c109`.
Bounded extraction retained exactly five immutable files, 166,657,892 bytes.
`SMB1R.exe` is 104,525,824 bytes,
SHA256 `94e895ee6874f51265312f06fbffb8fc26ec4a639920dbc83eaecead3ce9906f`.
The tree SHA256 is
`a8cb5667881f64dead389d8e8dd821bd4787f2b345156953d645f27412398b6a`.
The effective PCK inventory and engine identify Godot 4.6.3; the PE file-version
string is not used as the selected release identity.

The route accepts one deliberately narrow original subset: unchanged
`Super Mario Bros. (World).nes`, 40,976 bytes, whole-file SHA256
`0b3d9e1f01ed1668205bab34d6c82b0e281456e137352e4f36a9b2cfa3b66dea`,
SHA1 `33d23c2f2cfa4c9efec87f7bc1321ce3ce6c89bd`.
The pinned upstream verifier instead hashes Base64 text after stripping the
16-byte NES header, yielding
`c9b34443c0414f3b91ef496d8cfee9fdd72405d673985afa11fb56732c96152b`
for this original. That normalized protocol digest is not a whole-ROM digest.
The private source copy and its original archive remained unchanged.

## Shared data, executable inputs and consent

The closed `smb1r-1.1-stable-windows` contract requires this exact five-file
package, root working directory, no `portable.txt`, no local mutable paths,
and the fixed `--disable-mods` argument. Extra engine/CLI arguments are refused.
Staged-source capability version 10 and API schema 73 expose these consequential
semantics; prior contracts retain their meanings. Playnite consumes the account,
path, no-fallback and separate-consent fields rather than merely accepting them.

Core binds the current token-derived account identity and effective absolute
`APPDATA/SMB1R` path. It does not create that directory or seed its original.
After registration, the user manually copies the recognized original there as
`baserom.nes`. Missing cached original or unsafe settings requires manual
preparation, with `pending_setup=false`; it does not offer Core setup.
The shared scope includes originals, settings, saves, generated assets, custom
data, cache trashing and log pruning. A separate acknowledgment bound to the fresh
preview is required in addition to registration consent. Generic confirmation
alone grants no shared-data acknowledgment. No local fallback is offered.

Shared-tree metadata checks refuse reparse points, symlinks, hardlinks,
nonregular files and bounded-discovery failures. `settings.cfg` is bounded to
1 MiB and parsed as constructor-free data with section/key/value grammar and
finite depth/work. The optional resource-pack selection must contain only
`BaseAssets`. Godot loader sidecars `.remap`, `.import` and `.uid` are refused.
BaseAssets accepts only PNG files and its root `pack_info.json`.
Custom-character, custom-level/autosave, level-pack and blueprint files are
refused, preserving all bytes for manual relocation. Empty directories are allowed.

These restrictions follow the effective selected PCK: Godot resource loading
can follow sidecars even with mods disabled; custom-character properties can
select executable scene resources; level/editor/blueprint deserialization uses
unrestricted `str_to_var` before subsequent type checks. This minimum vanilla
route does not offer editor/import workflows or sandbox independent actions
inside an already running game. Checks repeat immediately before child creation.

Core does not own, isolate, migrate, update, back up, restore or delete this
runtime or account directory. Removal forgets only its registration. Managed
update, rollback and removal remain unoffered for this route.

## Actual acceptance and evidence identity

Private evidence root: `H:/pc6-qualification-20261019-a3/evidence`.
The implementation producer source is
`0cbac5e6d2a89a665fa8a086ff2219ed28392eb0`.
The qualified CLI in `smb-core-a6/portcove-smb-qualification.exe` has SHA256
`03b958be64b2905f006c001ea9346874007bd8816d5460963b4881e0fb5fb26c`.
Its clean source/build binding is in `smb-core-a6/source-binding-readback-a1.json`;
the original receipt's stale source label is preserved separately.
The actual private catalog has SHA256
`d302cde44780cc690248defb389c5b0d29f70ac97647cce6893f1c905e58e72c`.
These development identities are not protected catalog publication. The initial SMB producer used API 72 before main independently introduced relinking at API 72. The combined contract uses API 73; the original operation receipts keep their original producer identity.

`smb-registration-a3` exercised original registration, exact runtime preview,
generic-only/shared-only/stale-preview/changed-location refusal, then explicit
separate shared acknowledgment and registration. Before the manual original
copy, readiness required preparation without offering Core setup.
`smb-real-consumer-a1` rebuilt and ran the real Playnite consumer against actual
Core preview/readiness: six shared-preview/consent checks and one manual-setup
check passed. These are compiled contract observations, not native consent UI.

`smb-pre-spawn-a1` completed actual three loader-sidecar and junction refusals
with input preservation, then failed because its collector incorrectly selected
machine output for `exec`. CLI rejected that mode before creating any launch;
read-only database and fresh process proof confirmed zero launch activity.
Its reservation was preserved through an independently reviewed exact-owned
archive. The first archive attempt also retained a packaged-Windows path
resolution refusal before mutation. `smb-pre-spawn-a2` reused the completed
negatives and reached the nonce-bound `launch_ready_to_spawn` checkpoint twice.
Late unsafe settings and a custom-level/autosave input were refused after
release, with captured CLI termination, terminal failed Core sessions, no child
identities, independent process absence and restored healthy readiness.

`smb-native-a1` records two actual title/startup and ordinary native-window-close
cycles, requests `2645a4ad-af8a-4c9d-96d7-70e6065b5742` and
`ee8edd62-b885-439a-b447-436ff7cf9fcb`. Computer Use observed the title menu and
sent Alt+F4 to the exact owned window. Independently retained Windows process
handles, Core sessions and CLI termination each reported exit 0. The game
generated BaseAssets and settings; restart and post-close immutable revalidation
passed without broadening the contract. Originals and all five package files
remained unchanged. Successful wrapper return alone is not the exit proof.

`smb-maintenance-a1` refused a stale removal preview, removed only the
registration, compared complete bounded before/after manifests, then registered
again with a fresh preview and separate shared-data acknowledgment. All 182
protected files (runtime, shared data and original) remained unchanged. The final
registration was launchable with two successful launches; update, rollback and
managed removal remained explicitly unoffered. The original registration and
replacement registration retain their distinct identities in the receipt.

## Relink composition at API 73

Main advanced through `59c190da51e334aa58371d4e1465f7ae683e87b4`, including
the independently delivered API 72 retained-folder relink capability. Merge
`5c6fda42d86b3ca5acbca59edf0023d3321c2729` preserves it and exposes the
combined SMB contract as API 73. CLI and Tauri relink use the closed Core shared
disclosure and acknowledgment bound to the outer relink preview. React validates
the same disclosure for registration and relink. Playnite accepts the known
72–73 relink capability window while preserving its explicit refusal of relinking
shared-scope runtimes through that client; Desktop and CLI offer the reviewed flow.

`smb-core-a7` passed 16 shared-data and four relink tests. Its subsequent CLI
compile failed on one newly composed caller's nonnullable fallback assumption;
the retained failure is repaired by calling `write_scope_disclosure()`.
`smb-core-a7-resume-a1` completed the remaining CLI build, native/Core schema
parity and TypeScript generation without repeating the unchanged Core tests.
The clean committed producer `smb-core-a8` has SHA256
`7770bfa4eaddd32de2823029c8dd58303fee8a7a193afa7bd7cc0b57fbe8a398`.

`smb-clients-a2` preserved a failing future-schema fixture that still rejected
newly supported 73. Test-only commit
`38361b38ba1fb5f1cd9f308c65c3af1570827b56` moves that unknown case to 74;
product behavior is unchanged. `smb-clients-a3` passed all 499 compiled client
checks and three disclosure unit tests, then refused an incomplete browser run
because this worktree lacked the pinned Chromium shell. Its failure remains.
`smb-clients-a3-resume-a1` provisioned the repository browser dependency, executed
the previously unexecuted browser file (37 passed, none skipped), passed frontend
types and consumed an actual API 73 producer preview with the compiled client.
Producer and consumer source identities remain separate in their receipts.

`smb-relink-a1` copied the unchanged five-file runtime through the private harness,
then exercised actual Core relinking to that new folder. Changed APPDATA location,
unsafe shared loader metadata, missing shared acknowledgment, inner-preview
identity and stale outer-preview identity were refused. The APPDATA negative
tests a location change, not a different Windows account. Every refused mutation
left the entire registration unchanged. A valid outer-preview acknowledgment
changed the actual path and executable while retaining registration ID, timestamp,
version, shared binding and two-launch history. With the cached original
temporarily retained outside the shared directory, relink remained possible but
readiness required manual preparation; the actual compiled client consumed that
precise guidance without offering managed setup. Restoring the preserved original
returned launchable readiness. Complete bounded manifests proved that the old
runtime, shared data and original remained unchanged; the new runtime matched
all five immutable files. Core copied or moved no external files. No game ran
in this relink packet, and earlier native receipts retain their original producer.

CI `39336577642/1` at `8a6c55dec03cf5bebcd6c37962b33f0196cb4dd9`
retains its failed quality lane: the new disclosure test used the unpinned
`vitest` import and omitted an expected rejection message. The repair switches
to `vite-plus/test` and asserts the exact inconsistent-scope error for all four
negative cases. Product behavior is unchanged. `smb-lint-repair-a1` passed the
complete Vite+ check and all three exact disclosure unit tests. Required hosted
qualification belongs to the subsequent source head, not this failed run.

CI `39337422288/1` at `8dcf2de3a9a38c7b0b9404739401b683c1c96739`
retains three Rust failures: the new catalog entry omitted its original-game
title and authored setup guide, and prepared-route/capability inventory tests
still expected eleven routes and staged-source versions through eight.
The repair adds the title and four concrete preparation steps with ownership
warnings, retains the existing preparation notes, and explicitly tests versions
nine and ten and twelve prepared routes. Runtime behavior and native producer
identities are unchanged. The other 2,064 Rust tests passed in that failed run;
this is not a complete Rust-lane pass.
`smb-ci-rust-repair-a2` passed all 109 catalog tests and the actual CLI
capability/schema negotiation test. Its generated catalog bytes remain unchanged
after mirroring the metadata into current authoring and running the maintained
generator and stale-output check. The earlier A1 queue refused a source change
before executing any test; that refusal is retained.

The offered minimum is original-bound vanilla Windows registration, manual
shared-data preparation, launch, retained folder relink and registration-only removal. Gameplay,
populated-save/load, audio, controller, other platforms, installed Desktop and
human consent comprehension remain unobserved optional or separate evidence.
No original, modified executable or protected catalog was published.
