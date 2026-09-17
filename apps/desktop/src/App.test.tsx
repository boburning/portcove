import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import App, { BootstrapRecovery, missingBootstrapError } from "./App";
import { failureReport } from "./test-fixtures";

describe("Portcove app shell", () => {
  it("renders a useful startup state before Tauri returns library data", () => {
    const html = renderToStaticMarkup(<App />);
    expect(html).toContain("Portcove");
    expect(html).toContain("Opening your Portcove library");
    expect(html).toContain("recovery history");
    expect(html).toContain("release information");
    expect(html).not.toContain("native library");
  });

  it("renders startup failures as a recovery surface without library actions", () => {
    const error = failureReport();
    error.message = "The configured library cannot be opened.";
    error.presentation.summary = "The configured library cannot be opened.";
    error.details = { path: "Z:\\Portcove" };
    error.presentation.technical_context = { path: "Z:\\Portcove" };
    const html = renderToStaticMarkup(<BootstrapRecovery error={error} />);
    expect(html).toContain("Portcove couldn’t start");
    expect(html).toContain("The configured library cannot be opened.");
    expect(html).toContain("Z:\\Portcove");
    expect(html).toContain("View technical details");
    expect(html).toContain("<dt>Path</dt>");
    expect(html).not.toContain("<dt>path</dt>");
    expect(html.indexOf("Z:\\Portcove")).toBeGreaterThan(html.indexOf("<details"));
    expect(html).toContain("If the current library is the cause");
    expect(html).not.toContain("Portcove couldn’t open your library");
    expect(html).toContain("Retry startup");
    expect(html).not.toContain("Install");
  });

  it("keeps unrecognized startup fields exact inside technical details", () => {
    const error = failureReport();
    error.presentation.technical_context = { future_field: "exact-value" };
    const html = renderToStaticMarkup(<BootstrapRecovery error={error} />);

    expect(html).toContain('<summary data-focusable="true">View technical details</summary>');
    expect(html).toContain("<dt><code>future_field</code></dt>");
    expect(html).toContain("exact-value");
    expect(html.indexOf("future_field")).toBeGreaterThan(html.indexOf("<details"));
  });

  it("does not attribute an unclassified startup failure to the library", () => {
    const html = renderToStaticMarkup(<BootstrapRecovery error={missingBootstrapError} />);

    expect(html).toContain("Portcove couldn’t start");
    expect(html).toContain("Portcove could not start, and no error details were provided.");
    expect(html).toContain("Review the error details, then retry startup.");
    expect(html).not.toContain("Portcove couldn’t open your library");
    expect(html).not.toContain("Check the configured library path");
  });

  it("uses import recovery for an interrupted import", () => {
    const html = renderToStaticMarkup(
      <BootstrapRecovery
        error={{
          code: "conflict",
          message: "Import needs recovery",
          details: {
            transfer_id: "import-id",
            import_destination: "E:/Library",
            recovery_action: "resume_library_import",
          },
        }}
      />,
    );
    expect(html).toContain("Resume import");
    expect(html).not.toContain("Resume move");
  });
});
