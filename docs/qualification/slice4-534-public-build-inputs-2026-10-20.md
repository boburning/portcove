# Slice 4 secret-free updater build inputs and downstream provenance

Owner: [#534](https://github.com/boburning/portcove/issues/534). This connects
public build configuration to the selected initial-beta Windows/Linux package
route and existing aggregate admission. No production root, key, configuration
ref, signing or execution authority is installed by this change.

The Release identity job freezes the separately configured
`PORTCOVE_APPLICATION_PUBLIC_INPUTS_REVISION` and
`PORTCOVE_APPLICATION_PUBLIC_INPUTS_SHA256`. Each beta builder fetches that exact
commit from the fixed repository into a separate checkout with persisted Git
credentials disabled. Only the fixed public input files are read; their content
never supplies executable commands. The helper validates manifest identity,
root/key encoding, exact public origins and the fixed packaging overlay. It sets
the existing compile-time bundled-root/metadata/targets inputs and invokes the
pinned Tauri packaging route with `--no-sign`. Development and full-profile
defaults remain unchanged. NSIS remains current-user updater-owned; AppImage
remains user-writable updater-owned; DEB/RPM remain package-manager-owned.

The retained bundle includes the four original public files, generated exact
overlay and receipt, in a fresh private output directory. Its artifact name binds
platform/run/attempt, overwrite is disabled and retention is seven days. There
is no updater private key in compilation or package production.

Schema-3 admission configuration independently ratifies the public configuration
revision and manifest SHA256. Schema-3 assembly binds that same pair and the
complete selected platform set of immutable public-input artifacts, with numeric
artifact IDs and exact ZIP lengths/digests. Admission, assembler and attester
independently collect and verify the public bundles against provider run/attempt/
source identity, with bracketing readback. The existing signed aggregate predicate
and verifier bind the same normalized public identities. Missing public binding
refuses protected beta reservation. Historical schema-1/2 inputs remain readable
at their applicable diagnostic scope.

Before decompression, the maintained ZIP32 structural verifier checks the fixed
six-member allowlist, archive/expanded/individual limits, duplicates, paths,
lengths and CRCs. The fixed public-input validator is rerun, and generated overlay
and receipt must match exactly. Unexpected entries, changed manifests/origins/
overlay, wrong producer/run/attempt, aliased package/provenance/aggregate/bundle
IDs and changed provider inventory refuse. The bounded archive consumer does not
extract or execute candidate code.

## Evidence scope

The approved simpler setup's [schema-2 initial Root profile extension](slice4-single-owner-public-inputs-2026-10-22.md)
adds an explicit profile to the independently ratified public manifest and generated
recipe. Schema-1 behavior remains unchanged. This structural transport extension
does not establish cryptographic, compiler, native or production acceptance.

The implementation branch's focused suite has 102 tests: 98 pass and four
existing platform/publisher skips. Formatter, type-aware lint, diff checks and
the maintained indexed test inventory pass. Independent review cleared initial
head `6d83e6ac13e29163e4a505da732d34d5d3a267a0` and downstream head
`3fee73c0002719c2a2bd4e8c41f1de5c6ac6e25b`; final delivery composition/CI
is recorded on its PR. Original failed test assertions remain in the worktree
evidence; they are not described as passing runs.

This proves exact public configuration bytes and archive association. It does
not prove that a compiler used those inputs or that a package contains the
expected bundled root/configuration. `original_compiler` remains Unknown/null.
Actual secret-free package builds, embedded-input readback, native qualification,
isolated signatures, SBOM/native authorization and production acceptance remain
separate required integration/evidence. Structural root validation does not
establish production custody or crypto acceptance.

The final public root/key material and configuration commit/digest are generated
and independently verified under the eventual consolidated setup; no fake
production fingerprints are proposed here. Changes to those inputs invalidate
their dependent package/evidence binding. D1/D2/D3 remain selected, capacity is
bounded-attempt eligibility with Unknown availability/headroom and no capacity
reservation. #254 stays Done; #315/#534/#246 acceptance remains pending,
Chameleon protected acceptance unset, production held and Slice 5 excluded.
