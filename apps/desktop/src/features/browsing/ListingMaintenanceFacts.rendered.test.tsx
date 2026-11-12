import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vite-plus/test";
import type { PortListing } from "../../types";
import { ListingMaintenanceFacts } from "./ListingMaintenanceFacts";

it("translates maintenance labels and keeps authored catalog text verbatim", async () => {
  const { initializeLocalization } = await import("../../localization");
  const localization = initializeLocalization(["en-US"]);
  const condition = "upstream ships {{next}} <b>builds</b>";
  const listing = {
    release_maintenance: {
      pinned_releases: [],
      reason: "Authored reason",
      reconsider_when: condition,
    },
  } as unknown as PortListing;
  expect(renderToStaticMarkup(<ListingMaintenanceFacts listing={listing} />)).toContain(
    "Reconsider when: upstream ships {{next}} &lt;b&gt;builds&lt;/b&gt;",
  );
  try {
    await localization.changeLanguage("ar-XB");
    const markup = renderToStaticMarkup(<ListingMaintenanceFacts listing={listing} />);
    expect(markup).toContain("العرض المُدار الحالي");
    expect(markup).toContain(
      "إعادة النظر عندما: upstream ships {{next}} &lt;b&gt;builds&lt;/b&gt;",
    );
    expect(markup).toContain("Authored reason");
  } finally {
    await localization.changeLanguage("en");
  }
});
