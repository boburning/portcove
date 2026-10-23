import test from "node:test";
import { runPythonSuite } from "./python-test-results.mts";

void test("native guest binary custody transfer preserves refusal/partial effects without invoking WSL or a candidate", (context) => {
  runPythonSuite(
    new URL("./native-qualification-linux-transfer.test.py", import.meta.url),
    context,
  );
});
