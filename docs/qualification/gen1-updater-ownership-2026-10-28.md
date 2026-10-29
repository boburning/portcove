# Gen1Recomp runtime update owner — October 28, 2026

The subsequent [shared managed-fitting observation](gen1-managed-fitting-2026-10-28.md)
records ordinary restart and private-profile prerequisites separately. It retains
this updater guard's delivered scope and Red's historical qualification.

The existing Red definition uses Core's generated-cache management. Upstream
v0.3.97 can mount a newer `updates/gen1recomp-*.love` from the OS user profile
over its packaged source at boot. Portable mode does not relocate that payload
cache. Replacing the native executable therefore does not by itself establish
which runtime source will execute.

The current definition now supplies upstream's existing
`POKEPORT_PORTMASTER_MANAGED=1` packaging-ownership switch through Core's generic
launch environment. No per-title Core execution branch is introduced. The flag's
name comes from upstream's other package manager; its boot/check/prelaunch guards
are OS-independent and do not select another game or change the original input.

At exact tag v0.3.97 / `1eba2cf5821e770ba21ef409682f834a38ff5c01`, Boot refuses
payload enumeration/mount before reading user updates; Check refuses its worker
and reports idle; Prelaunch refuses the update stage even with an explicit
allow-update option. RomImporter can still report an updater UI predicate true
through its fused-build fallback. Final Check/Boot gates independently refuse
work; this repair does not assert that every updater-related predicate is false.

The actual publisher-hash Windows package contains byte-identical Boot, Check
and Prelaunch Lua modules. Nine isolated Lua module assertions, with controlled
environment/filesystem/thread/dependency mocks and unmanaged positive controls,
pass. Instrumented payload read/lookup/enumerate/mount/remove counters stay zero
under the guard; unmanaged and forced-gate-bypass controls reach payload IO even
through Boot.run’s error-catching wrapper. The initial harness lacked two dependency mocks; those harness failures
are retained separately. No native player, original game, helper, thread,
network request, populated profile, window or gameplay session was executed.
The adjacent JSON retains exact package/module hashes, old/new integration and
mock-test scope. Existing catalog regression coverage pins the required switch.

Old captured installation definitions retain their exact launch recipes. This
change neither rewrites those recipes nor transfers their data or historical
Windows qualification to the current release. Source identity, copied original,
portable marker, declared persistent paths and platform metadata remain intact.
The September owner acceptance on #98 remains historical evidence, not new
v0.3.97 execution. This scoped repair is owned by #2926/#2510 and does not reopen
or erase the historical completion.

Full maintenance remains pending implementation: current upstream adds slot
saves, staged/backup options and other profile writers outside the earlier
coordinate list. Audit those actual writes and exact runtime/source/data roots,
then qualify the offered replacement/preservation behavior separately. Preserve
existing working copies; no populated-data adoption, shrinking scope, save
conversion or old/new compatibility is approved here. Additional Gen1 engine
identities require their own original, maturity and route evidence. This switch
alone neither admits them nor completes the finite beta workstream.

Initial required CI run 40618977256/a1 at `e6cda2f4b377caa89202ff9bb9d29ecda1305399`
failed only the frozen schema-1/current-projection comparison. Its explicit
reviewed-delta allowlist omitted this new environment flag. The repair keeps the
frozen fixture unchanged, asserts its historical environment is empty, and adds
only this switch to the expected current projection. All other required producer
leaves passed. This failure remains retained; the repaired source needs fresh
independent review and all required exact-head checks.

The corrected frozen-projection test passed locally (one selected case, nextest
native status 0). The outer admitted wrapper exited 1 because its Linux reaper
did not finish within the cleanup budget and retained the shared lock. This is
not a complete local-pass or proven-quiescence receipt. No bypass/reclaim or
repeated local run was used to erase that uncertainty. Fresh hosted qualification
remains required for the repaired source.
