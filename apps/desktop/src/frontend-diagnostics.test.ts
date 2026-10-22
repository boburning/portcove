import { describe, expect, it } from "vite-plus/test";
import { frontendFailureReport } from "./frontend-diagnostics";

describe("frontend failure metadata", () => {
  it("sends typed metadata without messages, stacks, paths, URLs or credentials", () => {
    const report = frontendFailureReport(
      new TypeError("token=message-canary /private/path-canary"),
      {
        componentStack: "at https://private.invalid/?secret=stack-canary",
      },
    );
    expect(report).toMatchObject({ schema_version: 1, kind: "type_error", truncated: false });
    expect(report.report_id).toBeGreaterThan(0);
    expect(report.message_bytes).toBeGreaterThan(0);
    expect(report.stack_bytes).toBeGreaterThan(0);
    const serialized = JSON.stringify(report);
    for (const privateValue of ["canary", "private", "token", "https"])
      expect(serialized).not.toContain(privateValue);
    expect(Object.keys(report)).toEqual([
      "schema_version",
      "report_id",
      "kind",
      "message_bytes",
      "stack_bytes",
      "truncated",
    ]);
  });

  it("bounds multibyte inspection and allocates distinct descriptive report IDs", () => {
    const first = frontendFailureReport(new Error("界".repeat(1_000_000)), {
      componentStack: "😀".repeat(1_000_000),
    });
    const second = frontendFailureReport(new Error("short"), { componentStack: "" });
    expect(first).toMatchObject({ message_bytes: 1_023, stack_bytes: 4_096, truncated: true });
    expect(second).toMatchObject({ message_bytes: 5, stack_bytes: 0, truncated: false });
    expect(second.report_id).not.toBe(first.report_id);
    expect(JSON.stringify(first).length).toBeLessThan(200);
  });

  it("uses a closed error-kind vocabulary even for prototype property names", () => {
    const error = new Error("fixture");
    error.name = "constructor";
    expect(frontendFailureReport(error, {}).kind).toBe("unknown");
    error.name = "ReferenceError";
    expect(frontendFailureReport(error, {}).kind).toBe("reference_error");
  });
});
