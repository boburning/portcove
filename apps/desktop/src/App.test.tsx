import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import App, { BootstrapRecovery } from "./App";

describe("Portcove app shell", () => {
  it("renders a useful startup state before Tauri returns library data", () => {
    const html = renderToStaticMarkup(<App />);
    expect(html).toContain("Portcove");
    expect(html).toContain("Opening your native library");
    expect(html).toContain("recovery journal");
  });

  it("renders startup failures as a recovery surface without library actions", () => {
    const html = renderToStaticMarkup(<BootstrapRecovery error={{
      code: "state",
      message: "The configured library cannot be opened.",
      details: { path: "Z:\\Portcove" },
    }} />);
    expect(html).toContain("Your library needs attention");
    expect(html).toContain("The configured library cannot be opened.");
    expect(html).toContain("Z:\\Portcove");
    expect(html).toContain("Retry startup");
    expect(html).not.toContain("Install");
  });

  it("uses import recovery for an interrupted import", () => {
    const html = renderToStaticMarkup(<BootstrapRecovery error={{ code: "conflict", message: "Import needs recovery", details: { transfer_id: "import-id", import_destination: "E:/Library", recovery_action: "resume_library_import" } }} />);
    expect(html).toContain("Resume import");
    expect(html).not.toContain("Resume move");
  });
});
