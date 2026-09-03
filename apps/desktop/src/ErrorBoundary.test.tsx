import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AppErrorBoundary } from "./ErrorBoundary";

describe("top-level render recovery", () => {
  it("turns an injected render failure into a controlled recovery surface", () => {
    const error = new Error("injected render failure");
    const report = vi.fn();
    const boundary = new AppErrorBoundary({ children: <p>workspace</p>, report });
    boundary.state = AppErrorBoundary.getDerivedStateFromError(error);
    boundary.componentDidCatch(error, { componentStack: "at BrokenPanel" });

    const html = renderToStaticMarkup(boundary.render());

    expect(html).toContain('role="alert"');
    expect(html).toContain("Portcove hit a display error");
    expect(html).toContain("injected render failure");
    expect(html).not.toContain("workspace");
    expect(report).toHaveBeenCalledWith(error, expect.objectContaining({ componentStack: "at BrokenPanel" }));
  });
});
