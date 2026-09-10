import { describe, expect, it } from "vitest";
import { inspectCopy } from "./check-copy.mjs";

describe("desktop static-copy safeguards", () => {
  it.each(["adapter", "materialization", "Qualification pending", "persistent data", "source profile", "Source profiles"])("flags internal terminology in visible copy: %s", text => {
    expect(inspectCopy(`const view = <p>${text}</p>;`)).toEqual([expect.objectContaining({ rule: "internal-terminology", line: 1 })]);
  });
  it.each(["file(s)", "match(es)"])("flags parenthetical plurals in interpolated messages: %s", text => {
    expect(inspectCopy('const message = `Found ${count} ' + text + '`;')[0].rule).toBe("parenthetical-plural");
  });
  it("checks visible and accessible attributes and standalone message literals", () => {
    const findings = inspectCopy('const label = "Source profile"; const view = <button title="Materialization" aria-label="Verified">Check source</button>;');
    expect(findings.map(item => item.rule)).toEqual(["internal-terminology", "internal-terminology", "generic-verified"]);
  });
  it("distinguishes specific checks from a generic verified label", () => {
    expect(inspectCopy('const view = <><span>Verified</span><span>Verified local release</span><span>Exact match</span></>;').map(item => item.rule)).toEqual(["generic-verified"]);
  });
  it("allows code, type names, imports, identifiers and non-copy attributes", () => {
    expect(inspectCopy('import adapter from "adapter"; type Field = "qualification"; const data = { "source profile": value }; const ok = state === "qualification"; const view = <p className="qualification" id="adapter" data-state="verified">Exact match</p>; // materialization')).toEqual([]);
  });
  it("permits a named technical disclosure without exempting the rest of a component", () => {
    expect(inspectCopy('const view = <><details><summary>Technical details</summary><p>Qualification</p></details><p>Qualification</p></>;')).toEqual([expect.objectContaining({ rule: "internal-terminology" })]);
  });
  it("does not exempt ordinary disclosures or decoded visible entities", () => {
    expect(inspectCopy('const view = <details><summary>Advanced controls</summary><p>&#86;erified</p></details>;')).toEqual([expect.objectContaining({ rule: "generic-verified" })]);
  });
  it("checks concatenated copy while leaving machine comparisons alone", () => {
    expect(inspectCopy('const message = "source profile" + id; const same = state === "qualification";')).toEqual([expect.objectContaining({ rule: "internal-terminology" })]);
  });
  it("fails on malformed source instead of silently skipping it", () => {
    expect(() => inspectCopy('const view = <p title="broken')).toThrow();
  });
});
