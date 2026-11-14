import { ArrowUpRight, HandHeart } from "lucide-react";
import { fundingLinks } from "../features/browsing/funding-links";
import { useAppTranslation } from "../localization";
import { ExternalLink } from "./ExternalLink";

/**
 * Upstream support pages reviewed into the catalog listing. Ordinary external
 * links: nothing is fetched, and Core decides whether each exact URL may open.
 */
export function FundingLinks({ urls }: { urls: readonly string[] | null | undefined }) {
  const { t } = useAppTranslation("detail");
  const links = fundingLinks(urls);
  if (!links.length) return null;
  return (
    <section className="detail-funding mt-5" aria-labelledby="detail-funding-heading">
      <h4 id="detail-funding-heading" className="mb-1 text-sm font-semibold">
        {t("resources.funding.heading")}
      </h4>
      <p className="mb-1 max-w-prose text-sm text-pc-muted-foreground">
        {t("resources.funding.note")}
      </p>
      <ul className="m-0 list-none p-0">
        {links.map((link) => (
          <li key={link.url}>
            <ExternalLink
              href={link.url}
              className="flex w-full gap-2.5 border-b border-pc-border py-3 text-xs"
            >
              <HandHeart aria-hidden="true" />
              <span className="min-w-0 [overflow-wrap:anywhere]">
                {link.label}
                {link.detail && (
                  <>
                    {" "}
                    <bdi className="font-normal text-pc-muted-foreground">{link.detail}</bdi>
                  </>
                )}
              </span>
              <ArrowUpRight aria-hidden="true" />
            </ExternalLink>
          </li>
        ))}
      </ul>
    </section>
  );
}
