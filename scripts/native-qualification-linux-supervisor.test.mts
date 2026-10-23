import test from "node:test";
import { runPythonSuite } from "./python-test-results.mts";

void test("native guest lifetime inert models run without WSL, systemd, namespace or native execution", (context) => {
  runPythonSuite(
    new URL("./native-qualification-linux-supervisor.test.py", import.meta.url),
    context,
  );
});
