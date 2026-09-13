import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);

export function evaluateCiResults({ classifier, mode, prose, required, always = {} }) {
  if (classifier !== "success") throw new Error(`classifier result is ${classifier || "missing"}`);
  for (const [name, result] of Object.entries(always))
    if (result !== "success")
      throw new Error(`${name} was ${result || "missing"}, expected success in every plan`);
  if (!required || Object.keys(required).length === 0)
    throw new Error("required lane plan is empty");
  if (mode === "full") {
    if (prose !== "skipped")
      throw new Error(`prose lane was ${prose || "missing"}, expected skipped`);
    for (const [name, result] of Object.entries(required))
      if (result !== "success")
        throw new Error(`${name} was ${result || "missing"}, expected success`);
  } else if (mode === "prose") {
    if (prose !== "success")
      throw new Error(`prose lane was ${prose || "missing"}, expected success`);
    for (const [name, result] of Object.entries(required))
      if (result !== "skipped")
        throw new Error(`${name} was ${result || "missing"}, expected skipped`);
  } else {
    throw new Error(`classifier mode is ${mode || "missing"}`);
  }
  return `Accepted ${mode} plan for ${Object.keys(required).join(", ")}`;
}

function main() {
  let required, always;
  try {
    required = JSON.parse(process.env.PORTCOVE_REQUIRED_RESULTS ?? "");
    always = JSON.parse(process.env.PORTCOVE_ALWAYS_RESULTS ?? "{}");
  } catch {
    throw new Error("PORTCOVE_REQUIRED_RESULTS must be valid JSON");
  }
  console.log(
    evaluateCiResults({
      classifier: process.env.PORTCOVE_CLASSIFIER_RESULT,
      mode: process.env.PORTCOVE_CI_MODE,
      prose: process.env.PORTCOVE_PROSE_RESULT,
      required,
      always,
    }),
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
