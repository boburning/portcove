const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log(
    "usage: just desktop-test --app ABSOLUTE --output ABSOLUTE [--driver ABSOLUTE] [--native-driver ABSOLUTE] [options]",
  );
  console.log("Cached drivers are used when --driver and --native-driver are omitted.");
  console.log("Focused modes: --accessibility-only, --artwork-only, or --adoption-only.");
} else {
  await import("../apps/desktop/scripts/desktop-test.mjs");
}
