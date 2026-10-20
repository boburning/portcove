# Slice 4 keyless complete-site composition — October 20, 2026

Owner: #534. Implementation checkpoint, not deployment or publication authority.

The composer runs the exact hash-qualified Rust `assemble-tuf` executable with
public context and separately signed role envelopes. Its child receives owned
scratch home/temp paths and no inherited credentials. Actual Tough verification
precedes composition. The separately ratified application root digest is checked;
a self-consistent filesystem marker cannot supply authentication.

The complete site preserves the catalog subtree and every immutable application
metadata/target path. Its marker binds the independently expected prior generation,
root and exact file inventory. Stale preimages, changed/omitted immutable history,
symlinks, hardlinks, aliases, overlapping outputs and excess resource use refuse.
An unchanged replay returns the existing generation without new output. The site
is limited to 6,000 files and 256 MiB; installer payloads remain Release assets.

## Qualification

Source `1a3167639a4fbdf60b427097d7a8092aa4af1041` passes four filesystem/refusal
contracts. A resource-admitted actual-tool integration also passed at that source,
using disposable-key verifier source `5a5c39a2c9e3937f88cabc81c8e587720d765a3f`
and executable SHA-256
`64b57bd0726a2756add4bbbdb5758e6f0b78b7f20677636fc2c5dda11b7a0194`.
It produced generation
`effb8fd3d82ee0732ce6f8773da971883a9fc5ebc9ee307cf53443b6f2b699a3`,
returned `changed:false` for exact replay, and refused a corrupted signed envelope
while retaining the prior site bytes. Capture is retained under
`work/slice4/site-qualification-yB8Zqz` in the semantic Linux worktree. Resource
queueing took 340,249 ms; the admitted command exited zero. This verifies that
specific disposable tool/source pair, not later verifier revisions.

## Remaining connection

This delivery does not deploy Pages, authenticate a provider deployment, establish
exclusive execution, advance the remote coordinator or perform independent public
readback. Those steps must use the existing pending-intent/recovery machinery and
one keyless full-site deployer. Pages has no assumed expected-generation CAS API;
workflow concurrency alone cannot establish an exclusive authority. Production
remains held; no key, App, setting or feed has been provisioned by this work.

#254 remains Done. #315/#534/#246 acceptance is pending; Chameleon protected
acceptance is unset. Slice 5 is excluded.
