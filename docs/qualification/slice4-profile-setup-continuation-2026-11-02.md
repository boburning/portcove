# Recorded disabled-account profile continuation — November 2, 2026

Owner: [#534](https://github.com/boburning/portcove/issues/534). This extends the
[maintained October 22 continuation](slice4-profile-setup-continuation-2026-10-22.md)
to one newly observed partial setup. It does not create another recovery mechanism,
reset a password, authorize arbitrary account adoption, or activate production.

## Observed failure and retained state

The owner participated in one already-approved initial setup invocation. The first
fixed account, `PortcoveNativeQual`, was created disabled, with its SID ending in
`1010` and Users-only membership. Its profile registration, profile directory and
work directory are absent. The second account, `PortcovePublicProof`, is absent.
The recorded elevated parent and ordinary callers exited with code 1. Maintained
GET-only partial readback exited 0 and matched the original intent and account
identity. No credential was stored and no account or Task was enabled.

The initial launcher did not retain its console error. A bounded owned
PowerShellCore event subsequently recovered the actual failure: event 4100,
record 7281072, process 26308, at `2026-11-02T22:50:22.7545453Z`. Calling `Profile`
threw `COMException`: “The stub received bad data. (0x800706F7)”. A sanitized local
event retains the exact helper path/hash without password or transcript contents.
The [owning receipt](https://github.com/boburning/portcove/issues/534#issuecomment-6560833512)
retains the failed invocation, process results, readback and nonsecret artifact index.

The protected original helper remains unchanged at SHA-256
`ef2f88896f33f49053c367aa1621234527b9ba1306681776287fb5d2ba532c10`.
The original plan remains
`67c28f511ddb23f6826d7025e8bc012727608b8b7d3df9beaab3b0e282e3467b`.
Do not replay initial creation, reset or recreate the first account, delete the
partial records, or substitute the older account's receipts.

## Closed case binding

`scripts/resume-local-worker-profile.ps1` accepts only these recorded cases:

| Case                            | First SID suffix | Protected companion           | Intent and completion suffix |
| ------------------------------- | ---------------- | ----------------------------- | ---------------------------- |
| `20261022` (unchanged default)  | `1008`           | `profile-resume.ps1`          | `20261022`                   |
| `20261102` (explicit selection) | `1010`           | `profile-resume-20261102.ps1` | `20261102`                   |

The selected case owns the exact SID, five prefix byte counts/hashes and fixed
source/intent/completion names. These values are not caller-supplied selectors.
Unknown cases, another case's SID or records, unexpected namespace entries,
profiles or profile registrations, changed policy/groups, and unavailable provider
state refuse before mutation. The existing setup lock and protected ancestry,
single-link, byte identity and retained-source checks remain in force.

The November 2 prefix is:

| Record                        | Bytes | SHA-256                                                            |
| ----------------------------- | ----: | ------------------------------------------------------------------ |
| `intent.json`                 |   470 | `520a67b04ca85ceb1d275a22ef762e7671315124aa14ac420a89e0fcdf3d0236` |
| `account-0-intent.json`       |   135 | `4e8c0191320ca7b6906e538b5b734b3c0b9d54ce913f8141cd5140d53b849251` |
| `account-0-created.json`      |   311 | `b7a40db5566a4889c04e1559da8ff58fe13b6ee410711ca49cf67b885ee84c63` |
| `account-0-group-intent.json` |   172 | `89a6ee7a94059a64b5e00c7934394c4a86515d0e214caf9eb1e8d4a6ece2d124` |
| `account-0-group.json`        |   135 | `e2feaf8dea62c09ea03f0433fa6d045056d9e7929205e6a8f43bba68634e32c3` |

## Existing continuation and limits

The original helper's closed AST boundaries, first-account post-group suffix,
second-account loop and final permission/provider checks are reused. The existing
companion's 260-character buffer, managed ACL persistence, narrow ACL identity
comparison and dictionary-key compatibility remain unchanged. The first account's
SID, password and group addition are preserved; only the new second account has
an account-creation password prompt. Both accounts must remain disabled.

[Microsoft's CreateProfile contract](https://learn.microsoft.com/en-us/windows/win32/api/userenv/nf-userenv-createprofile)
documents a character-count buffer and administrator requirement, without stating
a maximum. The 260-character repair is already prepared for these fixed short
paths; its success on this actual partial setup remains unobserved. Read-only
binding resolution succeeded for both declarations and does not explain the
runtime error. No actual profile API retry is credited by this source change.

Completion continues to record the actual companion hash separately from the
original template hash, with the original intent, owned SID, buffer size and all
five original prefix hashes. The selected case's mandatory composite readback
checks its intent, completion, created receipt, disabled accounts, registered
profiles and observed ACL postimages. Existing original-template credential and
later explicit-enable consumers retain that composite receipt identity.

Stage only published, reviewed, exact-hash companion bytes privately at the
selected protected C path, and hold them against writers through execution.
Never elevate a mutable worktree file. Actual continuation remains held until
applicable review, exact-head CI, guarded delivery, source binding and execution
authority are resolved. Partial failure requires retained readback and no automatic
retry. No signing, private-key ceremony, controller/resource appointment, Task
activation or publication follows from this implementation.
