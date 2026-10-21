import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
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
    expect(html).toMatch(/<main class="bootstrap-state bootstrap-error(?: |")/u);
    expect(html).toMatch(
      /<p[^>]*role="alert"[^>]*>The configured library cannot be opened\.<\/p>/u,
    );
    expect(html).toContain("Portcove couldn’t start");
    expect(html).toContain("The configured library cannot be opened.");
    expect(html).toContain("Z:\\Portcove");
    expect(html).toContain("View technical details");
    expect(html).toMatch(/<dt[^>]*>Path<\/dt>/u);
    expect(html).not.toContain("<dt>path</dt>");
    expect(html.indexOf("Z:\\Portcove")).toBeGreaterThan(html.indexOf("<details"));
    expect(html).toContain("If the current library is the cause");
    expect(html).not.toContain("Portcove couldn’t open your library");
    expect(html).toContain("Retry startup");
    expect(html).toContain('data-slot="button" data-variant="primary"');
    expect(html).toMatch(/data-slot="button" data-variant="outline"[^>]*>Choose library<\/button>/);
    expect(html).toMatch(
      /data-slot="button" data-variant="outline"[^>]*>Use platform default<\/button>/,
    );
    expect(html).not.toContain("Install");
    expect(html).toContain("Create support bundle");
    expect(html).toContain("Game-file contents and saved credentials are excluded");
    expect(html).toContain("Review the bundle before sharing it");
    const exportButton = html.match(/<button([^>]*)>Create support bundle<\/button>/)?.[1];
    expect(exportButton).toBeDefined();
    expect(exportButton).not.toMatch(/\sdisabled(?:=|\s|$)/);
  });

  it("keeps unrecognized startup fields exact inside technical details", () => {
    const error = failureReport();
    error.presentation.technical_context = { future_field: "exact-value" };
    const html = renderToStaticMarkup(<BootstrapRecovery error={error} />);

    expect(html).toMatch(
      /<summary[^>]*data-focusable="true"[^>]*>View technical details<\/summary>/u,
    );
    expect(html).toMatch(/<dt[^>]*><code[^>]*>future_field<\/code><\/dt>/u);
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

  it("prevents reload and competing library choices while recovery is active", () => {
    const html = renderToStaticMarkup(
      <BootstrapRecovery error={missingBootstrapError} recoveryPending />,
    );
    expect(html).toContain('aria-busy="true"');
    expect(html).toMatch(/disabled=""[^>]*>Choose library<\/button>/);
    expect(html).toMatch(/disabled=""[^>]*>Use platform default<\/button>/);
    const retry = html.match(/<button([^>]*)>Retry startup<\/button>/)?.[1];
    expect(retry).toBeDefined();
    expect(retry).toMatch(/\sdisabled(?:=|\s|$)/);
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
    expect(html).toContain("Resume restore");
    expect(html).not.toContain("Resume move");
  });

  it("offers move abort only when the core marks it available", () => {
    const preActivation = renderToStaticMarkup(
      <BootstrapRecovery
        error={{
          code: "conflict",
          message: "Move needs recovery",
          details: {
            transfer_id: "move-id",
            retained_source: "E:/Library",
            recovery_action: "resume_library_move",
            move_abort_available: "true",
          },
        }}
      />,
    );
    expect(preActivation).toContain("Keep using original library");

    const postActivation = renderToStaticMarkup(
      <BootstrapRecovery
        error={{
          code: "conflict",
          message: "Move needs recovery",
          details: {
            transfer_id: "move-id",
            retained_source: "E:/Library",
            recovery_action: "resume_library_move",
            move_abort_available: "false",
          },
        }}
      />,
    );
    expect(postActivation).not.toContain("Keep using original library");
    expect(postActivation).toContain("Continue to finish the location change");
  });
});
