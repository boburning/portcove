import { createHash } from "node:crypto";
import path from "node:path";
import { isRecord } from "./runtime-values.mts";

const maximumRecords = 4096;
const maximumRecordBytes = 16_384;
const maximumTotalBytes = 4 * 1024 * 1024;
const integer = (value: unknown, minimum = 0): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
const text = (value: unknown, maximum: number): value is string =>
  typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= maximum;

function observedPath(value: unknown, root: string) {
  if (!text(value, 4096)) return;
  const absolute = path.resolve(root, value);
  const relative = path.relative(root, absolute);
  return (
    relative &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
      ? relative
      : absolute
  ).replaceAll("\\", "/");
}

function failureObservation(error: unknown) {
  if (!isRecord(error)) return null;
  const truncated: string[] = [];
  const field = (record: Record<string, unknown>, key: string, maximum: number) => {
    const value = record[key];
    if (typeof value !== "string") return null;
    if (value.length > maximum) truncated.push(key);
    return value.slice(0, maximum);
  };
  const cause = isRecord(error.cause) ? error.cause : null;
  return {
    name: field(error, "name", 128),
    message: field(error, "message", 2048),
    stack: field(error, "stack", 4096),
    code: field(error, "code", 128),
    failure_type: field(error, "failureType", 128),
    cause: cause
      ? {
          name: field(cause, "name", 128),
          message: field(cause, "message", 2048),
          stack: field(cause, "stack", 4096),
          code: field(cause, "code", 128),
        }
      : null,
    truncated_fields: truncated,
  };
}

/** Definition identities can have several instances; never deduplicate by name. */
export function nodeCaseObservation(event: unknown, root = process.cwd()) {
  if (
    !isRecord(event) ||
    (event.type !== "test:pass" && event.type !== "test:fail") ||
    !isRecord(event.data)
  )
    return;
  const value = event.data;
  if (!isRecord(value.details)) return;
  const details = value.details;
  const file = observedPath(value.file, root);
  const entryFile = value.entryFile === undefined ? null : observedPath(value.entryFile, root);
  if (
    !file ||
    entryFile === undefined ||
    !text(value.name, 2048) ||
    !integer(value.nesting) ||
    !integer(value.testNumber, 1) ||
    (value.line !== undefined && !integer(value.line, 1)) ||
    (value.column !== undefined && !integer(value.column, 1)) ||
    (value.testId !== undefined && !integer(value.testId, 1)) ||
    (value.parentId !== undefined && !integer(value.parentId)) ||
    (details.attempt !== undefined && !integer(details.attempt, 1)) ||
    typeof details.duration_ms !== "number" ||
    !Number.isFinite(details.duration_ms) ||
    details.duration_ms < 0 ||
    (details.type !== "test" && details.type !== "suite") ||
    (value.skip !== undefined &&
      typeof value.skip !== "boolean" &&
      (typeof value.skip !== "string" || Buffer.byteLength(value.skip) > 2048)) ||
    (value.todo !== undefined &&
      typeof value.todo !== "boolean" &&
      (typeof value.todo !== "string" || Buffer.byteLength(value.todo) > 2048))
  )
    return;
  const error = event.type === "test:fail" && isRecord(details.error) ? details.error : null;
  const kind = error && ("exitCode" in error || "signal" in error) ? "worker" : details.type;
  const definition = {
    file,
    entry_file: entryFile,
    line: integer(value.line, 1) ? value.line : null,
    column: integer(value.column, 1) ? value.column : null,
    name: value.name,
    classname: text(value.classname, 4096) ? value.classname : null,
    nesting: value.nesting,
    kind,
  };
  const skip = value.skip === true || typeof value.skip === "string";
  const todo = value.todo === true || typeof value.todo === "string";
  return {
    ...definition,
    definition_id: createHash("sha256").update(JSON.stringify(definition)).digest("hex"),
    test_id: integer(value.testId, 1) ? value.testId : null,
    parent_id: integer(value.parentId) ? value.parentId : null,
    test_number: value.testNumber,
    attempt: integer(details.attempt, 1) ? details.attempt : null,
    duration_ms: details.duration_ms,
    event: event.type,
    outcome: skip
      ? "skipped"
      : todo
        ? "todo"
        : error?.failureType === "cancelledByParent"
          ? "cancelled"
          : event.type === "test:pass"
            ? "passed"
            : "failed",
    skip_reason: typeof value.skip === "string" ? value.skip : null,
    todo_reason: typeof value.todo === "string" ? value.todo : null,
    failure: failureObservation(error),
  };
}

/** Bounded diagnostics only: malformed/oversized observations cannot change tests. */
export function createNodeCaseObservations(invocation: string, root = process.cwd()) {
  const records: string[] = [];
  let invalid = 0,
    omitted = 0,
    bytes = 0,
    seen = 0;
  return {
    capture(event: unknown) {
      if (!isRecord(event) || (event.type !== "test:pass" && event.type !== "test:fail")) return;
      const index = ++seen;
      try {
        const observation = nodeCaseObservation(event, root);
        if (!observation) {
          invalid++;
          return;
        }
        const line = `Node test case observation: ${JSON.stringify({ format_version: 1, invocation_id: invocation, observation_index: index, ...observation })}\n`;
        const size = Buffer.byteLength(line);
        if (
          records.length >= maximumRecords ||
          size > maximumRecordBytes ||
          bytes + size > maximumTotalBytes
        ) {
          omitted++;
          return;
        }
        records.push(line);
        bytes += size;
      } catch {
        invalid++;
      }
    },
    summary: () => ({ observed: records.length, invalid, omitted, bytes }),
    records: () => [...records],
  };
}
