# Slice 4 complete-site publication integration

Owner: [#534](https://github.com/boburning/portcove/issues/534). This is engineering
and local qualification evidence, not a production execution or publication grant.

## Actual local composition and archive evidence

The retained credential-free integration at source
`1645dc162d8d897329f9a154928404f646142cba` invoked the maintained Rust/Tough
`assemble-tuf` executable from reviewed source
`5817077b7682b47706432f95784d842d0ebeeaf8`, executable SHA-256
`b9dd6291f27d130dc0eadfc41d97776d6ca7f4b6c047056df0a1ad56ea699027`.
It used the public-only disposable-key role qualification fixture. Production
keys and provider write credentials were absent.

The real assembler and complete-site composer produced generation
`da09ccdecfc06d13cda0269ed30bf76a88d4199b372e82d81099fb17ac542f30` and
deterministic Pages tar SHA-256
`438171884efc06910b298cbe51857b65ee18312f9a8f77f5ac3ed339e8f73b92`.
Mutation of the exposed generation was refused; the private generation remained
unchanged during complete expected-byte HTTP readback. A provider-shaped artifact
response with status 403 refused before download. An exact opaque ZIP containing
the prepared tar passed independent archive verification.

The artifact provider and public HTTP responses in this run were simulated. The
result explicitly records `injected-provider`, `mock HTTP`,
`pages_deployment:false` and `production_keys:false`. It does not establish a
Pages deployment, provider enforcement, public availability or production custody.
The retained directory is
`E:/Codex-Worktrees/534-semantic-linux/Portcove-Development/work/slice4/site-deployment-qualification-JbY3ni`;
the resource-admitted run exited zero, with 208,773 ms queue and 213,646 ms total.

The earlier attempt at source `216c78563e6aa81042f5e7f6f1ef300959400268`
is retained in `site-deployment-qualification-NoZ00W`. Its verifier output streams
were empty and its collector did not retain process exit/signal facts. Its cause
remains unresolved; do not label it a TUF validation failure or a passing run.
The subsequent source retains bounded code/signal/killed diagnostics and uses a
finite 300-second process collection budget instead of 120 seconds. The later
pass does not establish that the budget change caused success.

## Provider and journal boundaries

The Pages transport fixes the repository, endpoint, public origin and Pages OIDC
audience. One instance claims its one-shot latch before asynchronous credential
acquisition. It performs at most one POST; failed, contradictory or lost responses
require readback. Neither raw bearer credentials nor provider diagnostics that
could echo them enter its receipts. A provider status of `succeed` remains status
evidence only: exact independent public bytes and existing journal settlement are
separate requirements. A deployment ID or source build version is not a Pages CAS
token or proof of the deploying actor.

Five provider contracts pass, including concurrent entry, lost/refused responses,
malformed zero-effect requests and status-only readback. The prior independent
review found and the repaired source fixed the asynchronous one-shot race.
Existing site/archive/readback contracts pass 11/11; executor and validation
registration contracts pass 19/19. These tests retain their local transport and
identity scopes.

The fixed executor now authenticates its exact coordinator, immutable-Release or
site-publication job through current OIDC and numeric provider job/check identity.
The site role uses the actual immutable-owner/repository `github-pages` subject.
It confirms remote pending intent before its single logical effect, retains the
exact result and records independent readback before confirmed remote settlement.
Stable logical destinations preserve retry accounting across regenerated IDs.
Fresh provider controls are required; an injected control source cannot publish.

Independent review found and repaired pre-effect gaps: maintenance now compares
the actual private assembler output with the frozen renewal's exact root,
offline Targets, unchanged records, six next versions and expirations before
any pending provider effect. Actual Rust composition and five output-mismatch
refusals pass in `work/slice4/site-renewal-pre-effect-binding.log` (six cases).
The transport accepts the fixed documented acknowledgement `/status` URL form
without following it; its own GET route stays fixed. It recognizes the maintained
terminal failure states. These capabilities were checked against the
[GitHub Pages REST contract](https://docs.github.com/en/rest/pages/pages#create-a-github-pages-deployment)
and [maintained deploy-pages status handling](https://github.com/actions/deploy-pages/blob/v4/src/internal/deployment.js),
not a live protected Pages operation.

The connected publisher reauthenticates its actual executor and reads fresh
controls after Pages token acquisition, immediately before the single POST.
The actual transport refuses a missing final guard. Seven provider contracts
pass, including a clock advanced beyond freshness during token acquisition
which produces zero POSTs and refuses repeat entry.

The site continuation checks the existing prior public generation and complete
prepared archive. Application publication also requires a private actual Release
preparation and fresh complete immutable Release/tag/asset readback. Maintenance
uses its own authenticated published-component lifecycle without a candidate or
new semantic review. Availability and headroom remain Unknown; no capacity
reservation is asserted.

Normal application feed execution currently has an explicit additional hold:
its full reconstructed record set must be privately bound to that exact accepted
aggregate/candidate/signature context. An unrelated validly signed context and
an immutable Release do not establish this relationship. The subsequent fixed
context integration must finish that connection before this hold is removed.
It is remaining engineering, not a new owner mechanism decision.

The report-capable Rust verifier built from `2a9f379f4ac48d87620410485468b99ab205c78b`
has SHA-256 `ed5811dc5e58e602196067a50ee4b815c34fe1c51adc5e44377a3e73ed0abdcb`.
An actual invocation against the retained disposable public renewal fixture
passed, and its publication facts were checked against emitted root, timestamp,
snapshot, offline Targets and complete public-component bytes. All 19 focused
site/provider contracts passed with this actual verifier case enabled. Nine
immutable Release contracts and twelve OIDC/session contracts passed separately.
These remain local tests, not protected execution or production custody evidence.

After successful provider settlement, the actual private verifier facts and
public generation advance `published_metadata` through the existing journal.
A later handoff failure does not permit another deployment. A separate actual
coordinator may complete this handoff only after observing the original exact
publisher terminal, independently reading all expected public bytes and matching
the existing settled operation/effect. Its path performs zero provider mutations.
An unresolved operation remains subject to the existing separate recovery path;
missing acknowledgement or effect evidence cannot be invented by this handoff.

Two real local Git-journal integration tests passed in
`work/slice4/executor-published-handoff-recovery.log` (50,690 ms). They demonstrate
remote pending intent before an effect; exact settled effects; a live-publisher
refusal before recovery readback; terminal-publisher handoff with an unchanged
active candidate; and retention/refusal after a simulated lost provider response.
The GitHub/JWKS/OIDC transport and metadata facts in these journal tests are
fixtures. The separate actual Rust case supplies the cryptographic component
evidence. Earlier URL-object fixture failure and the subsequent passing runs are
retained separately; no test grants provider or production authority.

Actual hosted site publication, the final controller revision/digest and resource
ratification, applicable custody, provider protections and consolidated setup
remain pending. #254 stays Done; #315/#534/#246 acceptance and Chameleon protected
acceptance retain their existing holds. Slice 5 is excluded.

## One Pages phase budget

The actual deployment session now retains an optional absolute monotonic phase
deadline supplied by the fixed controller. It follows the same attempt through
keyless Rust assembly, bounded filesystem composition, immutable upload
verification, the prior public readback, fresh controls, final immutable Release
readback, Pages token acquisition, the sole deployment POST, bounded status
observation and complete public-byte readback. Existing finite per-operation
limits remain upper bounds; none can restart the phase clock. A late provider
acknowledgement remains an attempted effect requiring readback, not permission
to POST again. The existing no-deadline component callers retain their limits.

Local component verification: 44 cases passed with one optional Rust case
skipped. The Rust case was then exercised with the retained public renewal
fixture and existing verifier SHA-256
`b8a200fd447c052b1170cc8168746dffaed013948fdc847f642e33b3f2d71ecc`:
all seven composer cases passed, including actual keyless assembly under the
same deadline. Evidence is retained at
`work/slice4/site-deadline-rust-composition-tests-1.log` and
`work/slice4/site-deadline-lint-2.log`. The first typed check exposed an explicit
`undefined` optional-property mismatch; the conditional projection was repaired
and the second typed check passed. Provider tests use inert credentials and
injected HTTP; they demonstrate refusal after credential delay and retention of
the one-shot boundary after a late successful POST response. They do not observe
production provider enforcement or clear the new-release record binding hold.

The final fixed caller and coordinator local-Git deadline composition remain
separate integration work. No setup, credential, signing or publication action
was performed by these checks.
