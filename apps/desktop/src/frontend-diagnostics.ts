import type { ErrorInfo } from "react";

export interface FrontendFailureReport {
  schema_version: 1;
  report_id: number;
  kind: "error" | "type_error" | "range_error" | "reference_error" | "syntax_error" | "unknown";
  message_bytes: number;
  stack_bytes: number;
  truncated: boolean;
}

let nextReportId = 1;

function boundedBytes(text: string, maximum: number) {
  let bytes = 0;
  for (const character of text) {
    const point = character.codePointAt(0)!;
    const length = point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
    if (bytes + length > maximum) return { bytes, truncated: true };
    bytes += length;
  }
  return { bytes, truncated: false };
}

/** Only closed metadata crosses IPC. Raw display details stay in the recovery
 * surface; error text, paths, URLs and component stacks are never forwarded. */
export function frontendFailureReport(error: Error, info: ErrorInfo): FrontendFailureReport {
  const message = boundedBytes(error.message, 1_024);
  const stack = boundedBytes(info.componentStack ?? "", 4_096);
  const kinds: Record<string, FrontendFailureReport["kind"]> = {
    Error: "error",
    TypeError: "type_error",
    RangeError: "range_error",
    ReferenceError: "reference_error",
    SyntaxError: "syntax_error",
  };
  const reportId = nextReportId;
  nextReportId = nextReportId === 0xffffffff ? 1 : nextReportId + 1;
  return {
    schema_version: 1,
    report_id: reportId,
    kind: Object.hasOwn(kinds, error.name) ? kinds[error.name]! : "unknown",
    message_bytes: message.bytes,
    stack_bytes: stack.bytes,
    truncated: message.truncated || stack.truncated,
  };
}
