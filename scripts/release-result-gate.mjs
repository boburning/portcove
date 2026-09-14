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

export function evaluateReleaseResults(results) {
  if (!results || typeof results !== "object" || Array.isArray(results)) {
    throw new Error("release result gate requires a job-result object");
  }
  for (const name of requiredJobs) {
    if (!(name in results)) throw new Error(`release result gate is missing ${name}`);
    if (results[name] !== "success") {
      throw new Error(`release result gate requires ${name}=success, received ${results[name]}`);
    }
  }
  return true;
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  const raw = process.env.PORTCOVE_RELEASE_RESULTS;
  if (!raw) throw new Error("PORTCOVE_RELEASE_RESULTS is required");
  evaluateReleaseResults(JSON.parse(raw));
  console.log(
    "Release identity, qualification, release audit, build matrix, and Intel verification all succeeded.",
  );
}
