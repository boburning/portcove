import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import App from "./App";

describe("Portcove app shell", () => {
  it("renders a useful loading state before Tauri returns library data", () => {
    const html = renderToStaticMarkup(<App />);
    expect(html).toContain("Portcove");
    expect(html).toContain("Your native library");
    expect(html).toContain("Loading your port library");
    expect(html).toContain("Open command palette");
  });
});
