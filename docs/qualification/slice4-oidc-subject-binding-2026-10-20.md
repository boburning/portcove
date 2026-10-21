# Fixed controller OIDC subjects

The existing authorized repository-configuration GET readback at
2026-10-20 18:11:27 UTC returned `use_default: true`,
`use_immutable_subject: true` and
`sub_claim_prefix: repo:boburning@43177418/portcove@1354613114` for public
`boburning/portcove`, repository ID `1354613114`, owner ID `43177418`, created
`2026-09-02T10:10:17Z`. The retained readback is
`work/slice4/github-oidc-subject-readback-2026-10-20.json`, SHA-256
`ca5cb1397ae749db7d4e3369c76511ec90f630681e23878d188d78a61fee982b`.
This is configuration evidence; no actual production JWT was collected and no
provider setting was changed.

[GitHub's OIDC reference](https://docs.github.com/en/actions/reference/security/oidc#immutable-subject-claims)
specifies immutable owner/repository IDs in the default subject for repositories
created after July 15, 2026. Its environment-subject rule also applies when a job
references a GitHub environment. The fixed verifier therefore derives this exact
immutable prefix and rejects the prior name-only subject, wrong owner/repository
IDs and cross-environment subjects. It also verifies the signed owner/repository
claims. It retains the independently expected tag ref, workflow and source claims
even for an environment-subject job.

The site reader uses `environment:github-pages`. All production phase observers
retain `environment:production-release-protection-observer`; the separate review
writer uses `environment:production-release-classification` and its observer uses
`environment:production-release-protection-observer`. Assembly, bootstrap,
admission, payload and immutable-release readers use the exact protected-tag
subject and require the signed environment claim to be absent. No environment,
credential location, protection policy or permission is removed by this change.
The root's site capacity-executor profile must use the same `github-pages`
environment when composed with this helper; this preparation does not claim that
separate caller has been delivered here.

Disposable signed-JWT fixtures cover the correct environment, missing/wrong
environment, legacy prefix, wrong owner/repository IDs and cross-subject refusal
before API reads. They do not establish real issuer execution, environment
protection enforcement, credential release, signing or publication authority.
Historical evidence remains retained at its original scope.
