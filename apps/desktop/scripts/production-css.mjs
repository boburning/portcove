function expectSource(failures, condition, message) {
  if (!condition) failures.push(message);
}

export function productionCssFailures(builtCss) {
  const failures = [];
  expectSource(failures, builtCss.length > 0, "production CSS output is empty");
  expectSource(
    failures,
    !builtCss.includes("12345px"),
    "production CSS includes the test-only discovery sentinel",
  );
  expectSource(
    failures,
    builtCss.includes("[data-theme=dark]"),
    "production CSS omits the data-theme dark variant",
  );
  for (const selector of [
    ".bg-pc-primary",
    ".bg-pc-scrim",
    ".active\\:bg-pc-primary-active",
    ".hover\\:bg-pc-danger-surface",
    ".text-pc-danger-strong",
    ".focus-visible\\:outline-pc-ring",
  ]) {
    expectSource(
      failures,
      builtCss.includes(selector),
      `production CSS omits required selector ${selector}`,
    );
  }
  return failures;
}
