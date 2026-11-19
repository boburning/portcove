import { ApplicationUpdateNotices } from "./ApplicationUpdateNotices";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import { defaultNoticeProps } from "../../components/rendered-test-fixtures";

describe("application update notice", () => {
  it("announces an available version with review and hide actions", () => {
    const html = renderToStaticMarkup(
      <ApplicationUpdateNotices {...defaultNoticeProps} version="0.2.0" review={vi.fn()} />,
    );
    expect(html).toContain("Portcove 0.2.0 is available");
    expect(html).toMatch(/data-variant="primary"[^>]*>Review update<\/button>/u);
    expect(html).toContain('aria-label="Hide update notice"');
  });

  it("renders nothing without an available version", () => {
    expect(renderToStaticMarkup(<ApplicationUpdateNotices {...defaultNoticeProps} />)).toBe("");
  });
});
