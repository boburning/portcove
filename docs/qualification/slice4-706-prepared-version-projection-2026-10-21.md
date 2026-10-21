# Exact version preparation and unchanged Linux risk scope

Owner: [#534](https://github.com/boburning/portcove/issues/534). This repair
connects the existing deterministic version preparation to final qualification.
It does not amend [#706](https://github.com/boburning/portcove/issues/706), accept
a vulnerability, advance its approved source, or permit another publication.

Previously, final qualification compared all four generated version authorities
with the original native-risk baseline. Even a correctly prepared version was
therefore indistinguishable from an arbitrary native-source change. The bounded
provider import also omitted the exact original preparation parent needed to
verify that distinction.

The maintained preparation verifier is now a data-only shared function. Its
existing bare-repository export still requires a bare repository. Verification
retains the actual raw commit SHA, exact parent/tree, fixed preparation actor,
source timestamp, canonical hashed intent, complete changed-path inventory,
regular file modes, and byte-for-byte reproduction of the four authorities.
The same 64-read/120-second verification bounds apply. A preparation-shaped
commit with altered dependency bytes refuses.

Only after that proof does #706 compare the unchanged approved baseline with
the preparation's exact original source. Ordinary commits keep their original
full native comparison. Genuine changes in that original source still require
reassessment. The final prepared HEAD, actual changed Cargo.lock digest, current
production dependency graph and failed full scanner result remain candidate
bound. Expiry, publication inventory, first-tag binding and publication count
are unchanged. This cannot enable a second ordinary Linux beta or extend the
existing risk approval to new native behavior.

The existing inert publication-source import now admits at most four exact
commit roots: candidate, fixed controller, verified preparation parent and risk
baseline. It does not traverse arbitrary ancestry. The original 256 MiB,
20,000-object, per-object bounds and coordinator deadline remain in force.
Standard shallow boundaries record that deliberately limited history in the
fresh caller-owned bare repository; raw parent bytes remain verified. The
ordinary qualification materializer verifies the preparation before fetching
that one exact parent at depth one. No candidate code, hooks or filters run.

Validation and retained failures:

- Actual disposable Git preparation verifies, a forged dependency edit refuses,
  and a genuinely changed original native file remains visible. The actual
  candidate reader retains the prepared HEAD and changed lock digest; Cargo
  metadata in this case is inert controlled input, not a live scanner result.
- The connected controlled-provider/raw-Git import, depth-one materialization and
  actual preparation verifier pass together. A candidate build-script canary
  remains unexecuted. Unrelated ancestry remains absent.
- The first expanded check was 38 pass / 1 fail: missing deliberately omitted
  ancestry caused Git metadata reading to refuse. Correct shallow boundaries
  repair that cause. The invalidated risk/import checks then passed 17/17 with
  zero skips. The unchanged qualification and plan checks passed in the earlier
  run. Type-aware lint passes for all nine implementation/registration files;
  its initial unnecessary non-null assertion diagnostic was repaired.
- Separate non-writing review covered both the full change and shallow-boundary
  repair. Hosted checks and final delivery identities belong to the linked PR.

The initial hosted source `ea2f7d1182e913b700aebd1cd25578fc225a091e`
passed four required contexts and tool fixture
[39557593548/1](https://github.com/boburning/portcove/actions/runs/39557593548),
but [CI 39557593672/1](https://github.com/boburning/portcove/actions/runs/39557593672)
failed its Windows helper producer (job `119081025346`) and dependent catalog
aggregate (`119081744271`). An eager verifier import pulled `semver` into the
intentionally dependency-free discovery reader-sharing test. The repair uses
one literal internal dynamic import after an actual preparation claim. Existing
security acquisition, Audit, Roadmap, finalizer, CLI and source materializers await
that result. It does not install dependencies or bypass the helper lane. An
isolated child imports the exact helper bytes with no verifier or dependency
tree, proving ordinary reads remain dependency-free. An intermediate synchronous
filesystem-loader attempt passed source tests but independent review correctly
rejected it because raw source is absent from the packed controller; it was never
delivered or exercised with protected authority.

The new packed regression uses a synthetic existing entry slot through the
unchanged actual production packer, exact maintained seven-module closure and
real disposable Git objects. It removes raw source and build dependencies before
the isolated child verifies the exact genuine six-field identity, returns null
for ordinary source, and refuses a forged third-party dependency edit. One case
passes, zero skips (5.775 seconds payload, 8.498 seconds admission wait). The first
fixture execution failed before object reading because Windows's device form
of the null path was unsuitable as Git's global configuration; an owned empty
configuration and hooks directory repair only that fixture environment. Both
logs and original closure identities are retained under
`work/risk706-packed-verifier/`. This proves the packing edge, not a complete
finalizer, dependency scan or provider execution. Queued source/typing checks
that observed the tracked regression changing refused before payload; they
supply no execution evidence. The original hosted failure also remains retained.

After the asynchronous repair and packed regression froze, the complete affected
risk/import/qualification selection passed 22/22 with zero skips. Type-aware lint
passed all ten changed acquisition/caller/regression files. Separate source
review checked every concrete asynchronous consumer, and independent test review
checked the synthetic packed-entry scope and owned Git configuration repair.
After composing the delivered Preview-withdrawal target, the actual Windows
reader-sharing case also passed with a Node resolution hook refusing every
nonbuiltin package (one case, zero skips, 2.775 seconds). This focused diagnostic
exercises the original failing consumer without using installed dependencies;
the hook and command are retained under `work/slice4/`. It is not a production
loader or a changed helper-lane dependency policy.

No provider protection, signing, publication, native execution or semantic
acceptance follows from these tests. The existing approved risk is still too
narrow to supply the complete multi-version public updater proof. Any actual
native-source reassessment or bounded additional-publication authorization
belongs in the consolidated setup decision, after independent engineering.
