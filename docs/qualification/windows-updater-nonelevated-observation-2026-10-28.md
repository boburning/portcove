# Windows updater local observation — October 28, 2026

Owners: [#224](https://github.com/boburning/portcove/issues/224) and
[#52](https://github.com/boburning/portcove/issues/52). This dated receipt records
actual local qualification work. It grants no protected release authority and
closes neither issue. The [current acceptance matrix](application-updater-beta-acceptance-2026-10-28.md)
retains the other platform and remaining rows.

## Exact scope and source

Three existing NSIS rehearsals passed on Windows 11 Home x86-64, kernel build
26300: controlled `0.1.0` → `0.2.0`, `0.1.0` → `0.3.0`, and
`1.0.0-rc.2` → `1.0.0`. These are current-source fixture versions, not historical
published releases. Both endpoint packages include
`application-update-qualification`; the installed predecessor additionally
includes `native-compatibility-qualification` for the embedded driver. No
ordinary default-feature updater journey follows from these packages.

Product and original harness source:
`adcbeaadaa6ca0f00be3f5eea4b835149c79d5b8`, base tree
`5fd8da9c63180b2c55ca4b67b0458a00d7e08dac`. Retained version patches,
configuration, public roots and feed bytes supplement that Git identity. The
[machine-readable receipt](windows-updater-nonelevated-observation-2026-10-28.json)
contains exact package/signature/key/report/role identities and native assertions.

Each native baseline records a non-elevated administrator flag `false` and
medium integrity `S-1-16-8192`. A separate current-controller token observation
records Administrators `S-1-5-32-544` as **deny-only**. This supports the measured
non-elevated per-user route; it is not a true standard-account, clean-VM,
minimum-Windows or complete child-token-group observation. Installation used
an explicitly owned disposable directory and HKCU registration, with passive
installer invocation. No interactive bootstrap/SmartScreen comprehension or
machine-wide installation is established.

## Package, signature and feed custody

| Profile         | Package role                     |      Bytes | SHA-256                                                            |
| --------------- | -------------------------------- | ---------: | ------------------------------------------------------------------ |
| legacy-adjacent | 0.1.0 qualified-predecessor      | 14,447,793 | `f09d6585af81da5860410423e101cafa86073fb920d4fc1930ec09e269b24b32` |
| legacy-adjacent | 0.2.0 qualification-candidate    | 13,721,914 | `7026ab96b613495ba5cc13b40c223174f9ef7d529fa84e11288bd572ea52b335` |
| legacy-skipped  | 0.1.0 qualified-predecessor      | 14,439,023 | `e81008b61c15ad5c4ebc4a02401e1198393e87f31ce0ca8c8b670fcbc8ac9d0b` |
| legacy-skipped  | 0.3.0 qualification-candidate    | 13,729,439 | `64ad75e94d01145916f6db1fefd6f4a9e286207189a633fc2b152cc7dde6557b` |
| preview-final   | 1.0.0-rc.2 qualified-predecessor | 14,451,936 | `1abd7a735963d3723ae2ce6f69044f9ba5c10dab9486206a44d97a03cca1c052` |
| preview-final   | 1.0.0 qualification-candidate    | 13,733,386 | `2613bf2ff0ada348acc039c617ebe0c0015c3c0e9cfa1eef8cf94f6a53469545` |

The actual feed-enabled predecessor is different from the preliminary package
with the same version in its original inventory. Its bytes were recovered from
the next cohort's `previous-bundles`, or the final owned bundle output, joined to
`package_inputs.predecessor_installer_sha256`, and separately retained with its
signature. Preliminary inventories are preserved with their original scope.

The existing maintained Rust release verifier, executable SHA-256
`009bd98d4ed037be16c948c67c94d2f3927349dc9727986592983e3ce692e5c2`,
independently accepted all six exact package/signature/public-key tuples.
Encoded `.pub` file hashes remain distinct from decoded Tauri/Minisign public-key
text hashes. A retained verifier input label `ordinary-candidate` is only a label;
it does not establish default-feature or production packaging.

Authenticode reports `NotSigned`. Payload signatures, the 24 retained signed
TUF root/role envelopes and their keys, versions and expiry, source/inventory
joins, and Windows publisher identity remain separate claims. The fixture
metadata's local run `1` is not a GitHub execution.

Every cohort used the same temporary file-transport URI base:
`file:///H:/Portcove-Worktrees/224-nonadmin-beta-20261028/work/updater-rehearsal/windows-installed-update-qualification/repository/`.
Its exact root, role signatures and package tuple distinguish successive feeds;
the URI alone cannot identify them. No public TLS/feed publication follows.
Disposable private payload/TUF signing inputs were absent before consumer work.

Three generated **local retention archives**, not provider artifacts, live under
`E:/Codex-Evidence/beta-updater-20261028/windows-adcbeaad-*.zip` alongside full
manifests. Independent inspection rehashed all 1,139 contained files and
736,025,417 expanded bytes. The JSON receipt records every outer ZIP and manifest
identity. Separately retained actual predecessors and signatures live under
`windows-qualified-predecessors/` with a custody ledger.

The rehearsal now moves the actual qualified Windows bundle into its owned run
root before installation, using the existing Linux/macOS retention helper. The
ordinary rehearsal upload explicitly retains the NSIS executable and signature.
The exact new move step was also executed on the actual retained final NSIS/signature pair: both hashes stayed identical and the original bundle directory was absent. This repairs future package custody; it does not make historical report-only
hosted-continuity archives complete.

## Installed results and helper OS measurement

The native reports record actual Settings Preview/Manual selection, explicit
check/download/Restart controls, exact staged package, Tauri setup and applied
state reconciliation, exact replacement executable and one matching HKCU version
registration. Subsequent qualified-candidate launch responded and closed with
OS exit `0`; uninstall launch/child exits, managed-file removal and registration
removal were also recorded. Damaged/truncated-stage refusal and recovery retain
their exact assertions. Expected refusal exits `1` are retained as expected reds.

The original helper success marker was self-reported `0`; later process
absence did not provide its OS code. Unchanged signed cohorts were replayed with
the delivered observer to collect that missing measurement. Successful replay
receipts for all three pairs retain a validated OS process handle through exit and require actual
`exit-observed` / `0`, independently of the marker. No process-disappearance
observation or collector completion is substituted for an exit code.

Replay tooling overlays exactly three reviewed files from
`ff99495460f25cbcf7a0721145441b164e2d8cfe` onto the ADC base. Product package bytes
and signed feed/root bytes remain unchanged and were genuinely unexpired at
reuse. The outer installer harness remains SHA-256
`10044112f8f58849b42b99d0d77e6b43cf4021fc52d503e70d0f793752c9d342`.
Git-head/tree fields still name ADC and alone do **not** describe this composed
observation source: the ledger additionally records overlay hashes/patch and
temporary version-metadata inputs. All four metadata files are restored with
byte readback; resource, native-session and frontend-output guards remain active.

## Preservation and retained failures

Across update, the checked continuity is the synthetic 32-byte
`user/installer-qualification/preserve.txt` marker (SHA-256
`70f6c4ee65826fee9dddcc4320fb47cb14a022d821202820f9eb7e9578e3433f`)
and the application/reconciliation state. Recursive library database/artwork
manifest equality is **uninstall-only**. The preference entry is absent in these
manifests; equality of absent entries cannot prove general preference continuity.
Preview/Manual update settings are intentionally changed by the UI. No real
installed games, original game inputs, saves, populated backups or existing
credential continuity is established.

All unsuccessful invocations remain separate from successful receipts:

- The original OEM437 Unicode CLI-smoke failure and the missing outer output
  reservation failed before NSIS; their focused repairs preserve the guards.
- Auxiliary captures refused a missing embedded snapshot file, a PowerShell
  timestamp conversion and an extended-path namespace. No OS exit was inferred.
  The timestamp diagnosis preserves the original ISO value; no clock changed.
- The first reuse attempt refused CRLF patch transport before fixture/native
  effects. The original patch remains; LF normalization uses exact context,
  without a whitespace-ignore option or altered signatures.
- A subsequent replay observed helper OS `0` but failed outer receipt archiving
  because its destination already existed. Its lifecycle remains failed. Fresh
  private output parents resolved the invocation error.
- An initial file-owner probe hit an NSIS extraction sharing violation; it did
  not establish ownership. Later snapshots are credited only where actually
  retained with matching executable hashes.

## Remaining acceptance

These observations do not satisfy historical updater-less release bootstrap,
real installed game/save/general preference/credential preservation, actual
reboot, remaining appropriate waiting/busy/remote-transport/minimum-environment
rows, or a chosen ordinary production candidate's complete package/feed/source
join. Current library/preferences overrides do not imply credential, WebView or
application-lease-store isolation. No clean isolated historical Windows profile
or rebootable environment was established here.

[#534](https://github.com/boburning/portcove/issues/534) retains actual production
Root/key/feed and eligible unchanged-client authority. Independent rehearsal and
fix delivery does not authorize publication or fabricate that gate. #224/#52
remain open for their actual criteria. Later full 1.0 qualification is #46;
macOS #226 and Steam Deck #535 do not become initial Windows/Linux beta blockers.
The separate #706/#49 Linux risk disposition is neither renewed nor remediated
by these Windows observations; exact candidate and policy require reconfirmation
at actual release time.
