import { runDefaultNextest } from "./nextest-outcomes.mts";
import { resourceEntrypoint } from "./resource-command.mts";

if (process.argv[2] !== "--run")
  throw new Error("Use the guarded Rust runner for default nextest outcomes");
process.exitCode = await resourceEntrypoint("rust", () => runDefaultNextest(process.argv.slice(3)));
