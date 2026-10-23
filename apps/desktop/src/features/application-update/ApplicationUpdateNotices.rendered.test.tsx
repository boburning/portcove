import { ApplicationUpdateNotices } from "./ApplicationUpdateNotices";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import { defaultNoticeProps } from "../../components/rendered-test-fixtures";

describe("desktop components", () => {
  it("uses semantic shared actions for application update notices", () => {
    const choice = renderToStaticMarkup(
      <ApplicationUpdateNotices
        {...defaultNoticeProps}
        updateChoiceRequired
        reviewUpdate={vi.fn()}
        dismissUpdateChoice={vi.fn()}
      />,
    );
    const transition = renderToStaticMarkup(
      <ApplicationUpdateNotices
        {...defaultNoticeProps}
        productionTransitionRequired
        useStable={vi.fn()}
        keepPreview={vi.fn()}
        dismissProductionTransition={vi.fn()}
      />,
    );

    expect(choice).toMatch(/data-variant="outline"[^>]*>Review options<\/button>/u);
    expect(choice).toMatch(/data-variant="ghost"[^>]*>Not now<\/button>/u);
    expect(transition).toMatch(/data-variant="primary"[^>]*>Use Stable<\/button>/u);
    expect(transition).toMatch(/data-variant="outline"[^>]*>Keep Preview<\/button>/u);
    expect(transition).toMatch(/data-variant="ghost"[^>]*>Not now<\/button>/u);
  });
});
