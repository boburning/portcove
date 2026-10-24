import axe from "axe-core";
import { expect } from "vite-plus/test";
import type { TestContext } from "vite-plus/test";

/** All default rules for an explicit rendered state; incomplete results remain findings. */
export async function auditAccessibility(
  root: Element,
  state: string,
  context: Pick<TestContext, "annotate">,
) {
  const { navigator, document, innerWidth, innerHeight, TextEncoder } = globalThis;
  const report = await axe.run(root);
  const findings = (items: typeof report.violations) =>
    items.map(({ id, impact, nodes }) => ({
      id,
      impact,
      nodes: nodes.map(({ target, failureSummary }) => ({ target, failureSummary })),
    }));
  const audit = {
    format_version: 1,
    state,
    scope:
      "explicit rendered application, modal, settings or repaired control root as labeled by state; browser harness excluded",
    browser_locale: navigator.language,
    browser_timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    direction: document.documentElement.dir,
    viewport: { width: innerWidth, height: innerHeight },
    axe_version: report.testEngine.version,
    rule_selection: "all default axe rules",
    passed_rules: report.passes.map(({ id }) => id),
    inapplicable_rules: report.inapplicable.map(({ id }) => id),
    violations: findings(report.violations),
    incomplete: findings(report.incomplete),
  };
  const body = new TextEncoder().encode(JSON.stringify({ accessibility_audit: audit }) + "\n");
  if (body.byteLength > 16_384) throw new Error("Accessibility audit exceeds16KiB");
  await context.annotate(`Accessibility state: ${state}`, "accessibility-audit", {
    body,
    contentType: "application/json",
  });
  globalThis.console.info(`Accessibility scenario observation: ${JSON.stringify(audit)}`);
  expect(findings(report.violations), state).toEqual([]);
  expect(findings(report.incomplete), `${state}: review incomplete checks explicitly`).toEqual([]);
  return report;
}
