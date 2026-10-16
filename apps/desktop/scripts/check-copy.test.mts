import assert from "node:assert/strict";
import { describe, it } from "vite-plus/test";
import { RuleTester } from "vite-plus/lint/plugins-dev";
import plugin from "./copy-lint-plugin.mts";
const { "player-copy": playerCopy, "theme-utilities": themeUtilities } = plugin.rules;
RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;
const tester = new RuleTester();
assert(playerCopy && themeUtilities, "Both repository lint rules must be registered");
const code = (text: string) => ({ filename: "fixture.tsx", code: text });
const invalid = (text: string, ...messages: string[]) => ({
  ...code(text),
  errors: messages.map((messageId) => ({ messageId })),
});
tester.run("player-copy", playerCopy, {
  valid: [
    code(
      'import adapter from "adapter"; type Field = "qualification"; const data = { "source profile": value }; const ok = state === "qualification"; const member = port.qualification; const computed = port["source profile"]; const view = <p className="qualification" id="adapter" data-state="verified">Exact match</p>; // materialization',
    ),
    code(
      "const view = <details><summary>Technical details</summary><p>Qualification</p></details>",
    ),
    code(
      "const view = <details><summary>Full identity and evidence</summary><p>Qualification</p></details>",
    ),
    code("const view = <p>Verified local release</p>"),
  ],
  invalid: [
    ...[
      "adapter",
      "materialization",
      "Qualification pending",
      "persistent data",
      "Source profiles",
    ].map((text) => invalid(`const view = <p>${text}</p>`, "internal-terminology")),
    invalid("const message = `Found ${count} file(s)`", "parenthetical-plural"),
    invalid("const message = `Found ${count} match(es)`", "parenthetical-plural"),
    invalid(
      'const label = "Source profile"; const view = <button title="Materialization" aria-label="Verified">Check source</button>',
      "internal-terminology",
      "internal-terminology",
      "generic-verified",
    ),
    invalid(
      "const view = <><details><summary>Technical details</summary><p>Qualification</p></details><p>Qualification</p></>",
      "internal-terminology",
    ),
    invalid(
      'const view = <details><summary>Advanced controls</summary><p title="&#86;erified">&#86;erified</p></details>',
      "generic-verified",
      "generic-verified",
    ),
    invalid(
      'const message = "source profile" + id; const same = state === "qualification"',
      "internal-terminology",
    ),
    {
      ...code("const π = 1;\r\nconst message = `Verifi\\u0065d`;"),
      errors: [{ messageId: "generic-verified", line: 2, column: 16 }],
    },
  ],
});

tester.run("theme-utilities", themeUtilities, {
  valid: [
    {
      filename: "apps/desktop/src/components/ui/button.tsx",
      code: 'const classes = "text-[length:var(--text-sm)] bg-pc-danger-surface";',
    },
  ],
  invalid: [
    {
      filename: "apps/desktop/src/Card.tsx",
      code: 'const classes = "text-[var(--text-sm)]";',
      errors: [{ messageId: "ambiguous" }],
    },
    {
      filename: "apps/desktop/src/components/ui/button.tsx",
      code: 'const classes = "bg-[#000]";',
      errors: [{ messageId: "raw" }],
    },
    {
      filename: "apps/desktop/src/components/ui/dialog.tsx",
      code: "const view = <div className={`pe-${size}`} />;",
      errors: [{ messageId: "dynamic" }],
    },
  ],
});
