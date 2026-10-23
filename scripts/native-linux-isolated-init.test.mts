import test from "node:test";
import { runPythonSuite } from "./python-test-results.mts";

void test("private native init protocol/entry assertions run without namespaces, GUI, credentials or native execution", (context) => {
  runPythonSuite(new URL("./native-linux-isolated-init.test.py", import.meta.url), context);
});
