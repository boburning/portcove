# Recovery tool bootstrap qualification — October 28, 2026

Owner: #534, consumed by #315/#246. This is actual public-tool bootstrap and
verification evidence on Linux x64. It is not an encrypted vault, recovered key,
installed capable client, protected signing or publication result.

The opt-in `scripts/prepare-recovery-tools.mts --prepare PRIVATE_PARENT` route
uses a separate Aqua configuration. Ordinary frontend/native setup is unchanged.
All effects were beneath this workstream's ignored private `work/` directories;
no global shim, persistent environment, E: storage, recovery repository, real key,
App appointment or production configuration was changed.

## Exact public inputs

| Input                                 | Exact source / provider identity                                                                                                                          | Bytes / SHA-256                                                                 |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Aqua 2.64.0 Linux x64                 | `aquaproj/aqua`, source `954fd59f789f69445ddb13903721de8b9e9a05b2`, release `404596631`, asset `615231584`                                                | 9,701,961 / `b276e927ee2f4dc214831708c0843a91007bafa06f2f9fcd6ee1fd73fd165598`  |
| Verifier GitHub CLI 2.102.0 Linux x64 | `cli/cli`, release `399674740`, asset `599854672`; exact archive checksum independently retained in Aqua's pinned `pkg/ghattestation/aqua-checksums.json` | 15,319,960 / `bb766f710eef8ede859c18578c72c327597cd4c8a85b06001b1f3843c6019386` |
| age 1.3.2 Linux x64                   | `FiloSottile/age`, repository `187403699`, owner `1225294`, source `b74dce4cdbe35b5e5f66c06d9612b72f89028758`, release `379059621`, asset `535541903`     | 19,405,817 / `cbe24006683f8eb669266162894b9a522a1af52f2665fbc63a4bb032ed26ac10` |

Aqua's pinned verifier implementation can treat authentication errors as success
and retries other verification errors. The installer therefore uses Aqua only
for checksum-pinned staging and requires one separate direct verification:

```text
gh attestation verify AGE_ARCHIVE --repo FiloSottile/age
  --signer-workflow FiloSottile/age/.github/workflows/build.yml
  --source-digest b74dce4cdbe35b5e5f66c06d9612b72f89028758
  --source-ref refs/tags/v1.3.2
  --predicate-type https://slsa.dev/provenance/v1 --format json
```

That exact managed verifier must match its independently pinned archive before
execution. The direct command returned exit 0. Its verified statement binds the
requested subject among nine release subjects to the pinned source and workflow,
with build invocation
`https://github.com/FiloSottile/age/actions/runs/33266893827/attempts/1`.
The raw verified JSON SHA-256 is
`d01f490c37708536606ea1ea149d4ee179699042e4840408ff6ebc1ee0c6b565`.
A first downloaded digest or Aqua's install result alone was not accepted.

The installed age and age-keygen files matched the corresponding members of that
attested archive and each reported `v1.3.2`. The package additionally contains
age-inspect and four plugin executables; the pinned source builds `cmd/...` and
`extra/...`. They were inventoried, not executed or appointed as recovery inputs.
Aqua also staged its built-in aqua-proxy 1.2.13 and private links; this route
invokes absolute resolved binaries and does not invoke those links.

## Observations and retained failures

The cold successful installer measured 7,351 ms inside its original deadline;
resource supervision measured 10,128 ms total including 597 ms admission queue.
The bounded-reader repair's actual warm revalidation returned `reused: true`,
with 13,658 ms supervised total including 781 ms queue. An earlier warm observation
measured 51,626 ms; these are different observations, not a claimed speedup or
production job budget qualification. The qualified cache inventory measured 275
regular files, 154,341,197 logical bytes, 155,058,176 allocated bytes and four
unfollowed links.

Actual direct verifier controls with a different source digest and a different
producer workflow each returned exit 1. Actual owned cache controls refused
changed tool bytes, a symlink, a missing companion, interrupted preparation and a
changed archive, preserving original receipts without automatic reinstall.

The first attempt's verified response was rejected because the initial result
parser incorrectly required one subject. The next attempt exposed two additional
source-declared archive members, age-inspect and age-plugin-batchpass. Their exact
pinned packaging source was reconciled; arbitrary members, links and extensions
remain refused. Both original partial attempts and errors were retained. The
successful cryptographic proof was preserved through the later bounded-reader
repair; it was not replaced by fixture claims.

The final focused contracts exercise eight recovery cases and 25 existing
controller-tool cases: 33 passes, zero failures/skips. Real temporary-file growth
after held stat is bounded to the original size plus one; real replacement,
oversize, unsafe inode representation, corrupt cache archive/binary/proof and the
exact 2,048-record boundary refuse. Fixture pins and producer-shaped JSON test
integrity only and establish no cryptographic or production authority.

Raw local evidence is retained in the owning
`534-recovery-age-bootstrap/work/recovery-age-bootstrap/` and
`work/recovery-managed-cache-qualified/` directories. The cold receipt SHA-256 is
`136b141f307b6378db4485b4c7c5eaad937e675cc82d33017496ce799e75a2a9`.
The complete working-source qualification manifest SHA-256 is
`0e8fa3d623c827132e6aa151b296b647dc6768d47637ebb9db3ebd00edbd2584`.
It identifies its source files explicitly; merge qualification remains bound to
the PR's final reviewed head and required CI.

## Bounds and remaining scope

The original preparation deadline is ten minutes, with a 650-second outer
supervisor, at most one approved HTTPS redirect per explicit download, exact
compressed sizes/digests and no automatic operation retry. Raw gzip decoding is
bounded to 128 MiB before TAR record inspection; at most 2,048 regular/directory
records, 256-byte names and 64-MiB files are supported. PAX, GNU long-name/sparse
extensions, links, collisions, path escapes and foreign members refuse before
extraction writes. Cache reads use the maintained held-handle NOFOLLOW reader,
with owner, single-link and safe-integer identity checks on this Linux route.
Windows x64 archive checksums are prepared inputs, not Windows bootstrap evidence.

The complete appointed-role inventory and encrypted create/restore adapter remain
unfinished. No passphrase or real recovery material was requested. Actual key
custody, restore/loss/rotation, independently appointed catalog Root, capable
installed-client baseline and all protected #315/#246/#534 proofs remain held at
their exact separate prerequisites. No paid fallback or resource-policy increase
was introduced.
