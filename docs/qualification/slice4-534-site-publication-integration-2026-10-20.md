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

The fixed executor integration is continuing through the existing coordinator
journal. Durable pending intent, exclusive actual job ownership, fresh controls,
exact completed effects, independent readback and confirmed remote settlement
must precede later operations. Metadata renewal uses its own authenticated
published-component lifecycle and never invents a release candidate. Availability
and headroom remain Unknown and no capacity reservation is asserted.

Actual hosted site publication, the final controller revision/digest and resource
ratification, applicable custody, provider protections and consolidated setup
remain pending. #254 stays Done; #315/#534/#246 acceptance and Chameleon protected
acceptance retain their existing holds. Slice 5 is excluded.
