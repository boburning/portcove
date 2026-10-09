# Triage labels

| Canonical role  | Tracker label   | Meaning                                  |
| --------------- | --------------- | ---------------------------------------- |
| needs-triage    | needs-triage    | Maintainer needs to evaluate             |
| needs-info      | needs-info      | Waiting on reporter information          |
| ready-for-agent | ready-for-agent | Fully specified for agent implementation |
| ready-for-human | ready-for-human | Requires human implementation            |
| wontfix         | wontfix         | Will not be actioned                     |

Use these exact strings when an engineering skill names a triage role.

Labels are supplementary annotations. Missing labels do not establish missing
triage or unfinished work. `ready-for-agent` describes specification completeness;
execution still follows the live Project and [pickup contract](../PROJECT-GOVERNANCE.md#pickup-consumption-and-execution-upkeep).
Use `portcove-roadmap` for authorized disposition changes and readback. A `wontfix`
label alone does not establish completion or alter catalog support.
