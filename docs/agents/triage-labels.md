# Triage labels

| Canonical role  | Tracker label   | Meaning                                  |
| --------------- | --------------- | ---------------------------------------- |
| needs-triage    | needs-triage    | Maintainer needs to evaluate             |
| needs-info      | needs-info      | Waiting on reporter information          |
| ready-for-agent | ready-for-agent | Fully specified for agent implementation |
| ready-for-human | ready-for-human | Requires human implementation            |
| wontfix         | wontfix         | Will not be actioned                     |

Use these exact strings when an engineering skill names a triage role.

These labels supplement the live Project. They do not replace Project
Status, readiness, reservations, qualification, review, or acceptance
and merge authority. Read the current issue and Project state before
recommending or applying a transition.

During triage discovery, missing triage labels mean missing annotations,
not proof that an issue is untriaged or unfinished. Read existing Project
classification and issue evidence before placing it in an intake bucket;
preserve completed work and active reservations.

`ready-for-agent` describes specification completeness. Execution
eligibility still depends on live Project fields, blockers, reservations,
and the repository's validation and delivery requirements.

For an authorized outcome that changes issue disposition, reconcile and
verify the corresponding Project state through `portcove-roadmap`.
Read back any automatic closure transition. A `wontfix` label alone does
not establish completion evidence or change Port stage or catalog support.
