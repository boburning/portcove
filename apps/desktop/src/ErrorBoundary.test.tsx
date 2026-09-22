import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AppErrorBoundary } from "./ErrorBoundary";

describe("top-level render recovery", () => {
  it("turns an injected render failure into a controlled recovery surface", () => {
    const error = new Error("injected render failure");
    const report = vi.fn();
    const boundary = new AppErrorBoundary({
      children: <p>workspace</p>,
      report,
    });
    boundary.state = AppErrorBoundary.getDerivedStateFromError(error);
    boundary.componentDidCatch(error, { componentStack: "at BrokenPanel" });

    const html = renderToStaticMarkup(boundary.render());

    expect(html).toContain('role="alert"');
    expect(html).toContain("Display error");
    expect(html).toContain(
      "The Portcove window encountered an error. Reload it to reconnect and check the status of any active task.",
    );
    expect(html).toContain("injected render failure");
    expect(html).toContain('data-slot="button" data-variant="primary"');
    expect(html).toContain("Reload Portcove");
    expect(html).not.toContain("remains owned by the backend");
    expect(html).not.toContain("workspace");
    expect(report).toHaveBeenCalledWith(
      error,
      expect.objectContaining({ componentStack: "at BrokenPanel" }),
    );
  });

  it("labels a render failure without supplied details as an unknown display error", () => {
    const boundary = new AppErrorBoundary({ children: <p>workspace</p> });
    boundary.state = AppErrorBoundary.getDerivedStateFromError(new Error(""));

    expect(renderToStaticMarkup(boundary.render())).toContain("Unknown display error");
  });
});
