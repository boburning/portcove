import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const requiredJobs = [
  "identity",
  "qualification",
  "validate",
  "build",
  "build_intel",
  "verify_intel",
];

export function evaluateReleaseResults(results: unknown) {
  if (!results || typeof results !== "object" || Array.isArray(results)) {
    throw new Error("release result gate requires a job-result object");
  }
  for (const name of requiredJobs) {
    if (!(name in results)) throw new Error(`release result gate is missing ${name}`);
    const result: unknown = Reflect.get(results, name);
    if (result !== "success") {
      throw new Error(`release result gate requires ${name}=success, received ${String(result)}`);
    }
  }
  return true;
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  const raw = process.env.PORTCOVE_RELEASE_RESULTS;
  if (!raw) throw new Error("PORTCOVE_RELEASE_RESULTS is required");
  evaluateReleaseResults(JSON.parse(raw));
  console.log(
    "Required release decision and qualification jobs succeeded; retained security evidence distinguishes scan results from approved risk dispositions.",
  );
}
