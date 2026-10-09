# Engineering techniques

Use the installed Matt Pocock techniques when they help the task. They are
recommendations, not compulsory loads or additional approval/check stages.
An explicitly named skill applies; relevant specialist safety routes still apply.
The [agent contract](../../AGENTS.md) and owning repository contracts take precedence.

| Need                                | Suggested technique                                      |
| ----------------------------------- | -------------------------------------------------------- |
| Incremental behavior implementation | `tdd`, using an existing public interface                |
| Difficult or recurring failure      | `diagnosing-bugs`, with a discriminating reproduction    |
| Interface/responsibility decision   | `codebase-design`                                        |
| Agent-facing documentation          | `writing-for-agents`                                     |
| Independent review                  | `code-review` principles for specification and standards |

Load only the chosen definition and relevant references. An unavailable optional
technique does not block ordinary delivery. Grilling, wayfinding, broad surveys
and retrospectives require a relevant explicit task. Preserve plugin caches and
invocation settings.

Repository [review and merge](../CONTRIBUTION-CONVENTIONS.md#review-and-merge),
[validation](../QUALITY.md#required-hosted-baseline) and
[blocked-work preservation](../PROJECT-GOVERNANCE.md#pickup-consumption-and-execution-upkeep)
have one owner each. Technique instructions do not create another delivery loop.
