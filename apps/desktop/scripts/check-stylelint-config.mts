import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import stylelint from "stylelint";

const configFile = fileURLToPath(new URL("./stylelint-config.mts", import.meta.url));
const component = fileURLToPath(new URL("../src/styles/stylelint-contract.css", import.meta.url));
const resolved = await stylelint.resolveConfig(component, { configFile });
assert.ok(resolved);
const rules = resolved.rules;
assert.ok(rules);
for (const rule of [
  "at-charset-rule-no-invalid",
  "selector-no-deprecated",
  "selector-no-invalid",
  "selector-no-unmatchable",
  "value-no-invalid",
]) {
  const value: unknown = rules[rule];
  assert.ok(
    value === true || (Array.isArray(value) && value[0] === true),
    `${rule} must stay enabled`,
  );
}
const cases = [
  { code: ".fixture { color: var(--foreground); }", rule: null },
  { code: ".fixture { color: #fff; }", rule: "portcove/semantic-colors" },
  { code: ".fixture { color: var(--n64-foreground); }", rule: "portcove/semantic-colors" },
  { code: ".fixture { color: var(--foreground) !important; }", rule: "declaration-no-important" },
  {
    code: ".fixture { background: linear-gradient(var(--a), var(--b)); }",
    rule: "function-disallowed-list",
  },
  { code: ".fixture { width: calc(1px + 1); }", rule: "value-no-invalid" },
];
for (const { code, rule } of cases) {
  const result = await stylelint.lint({ code, codeFilename: component, configFile });
  assert.equal(result.results.length, 1);
  const warnings = result.results[0]!.warnings;
  if (rule === null) {
    assert.equal(result.errored, false, JSON.stringify(warnings));
    assert.equal(warnings.length, 0);
  } else {
    assert.equal(result.errored, true);
    assert.ok(
      warnings.some((warning) => warning.rule === rule),
      JSON.stringify(warnings),
    );
  }
}
console.log(
  "Native typed Stylelint configuration: five recommended rules enabled; semantic positive and five refusal controls passed.",
);
