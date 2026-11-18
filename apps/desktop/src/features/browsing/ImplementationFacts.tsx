import { ExternalLink } from "../../components/ExternalLink";
import type { CatalogEntry } from "./catalog-entry";
import {
  implementationMetadata,
  implementationMethodLabels,
  dependencyKindLabels,
} from "./implementation-metadata";

/** Describes upstream techniques, never setup eligibility, support or save compatibility. */
export function ImplementationFacts({ port }: { port: CatalogEntry }) {
  const metadata = implementationMetadata(port);
  if (!metadata) return null;
  return (
    <details className="mt-4 min-w-0 wrap-anywhere">
      <summary data-focusable>How this project works — {port.name}</summary>
      <ul>
        {metadata.methods.map((method) => (
          <li key={method.kind}>
            <strong>{implementationMethodLabels[method.kind]}</strong>
            {method.note && <p>{method.note}</p>}
            {method.evidence_urls.map((url, index) => (
              <span key={url}>
                {" "}
                <ExternalLink href={url}>
                  {implementationMethodLabels[method.kind]} source {index + 1} — {port.name}
                </ExternalLink>
              </span>
            ))}
          </li>
        ))}
        {metadata.dependencies.map((dependency) => (
          <li key={`${dependency.kind}:${dependency.project_url}`}>
            {dependencyKindLabels[dependency.kind]}{" "}
            <ExternalLink href={dependency.project_url}>{dependency.name}</ExternalLink>
            {dependency.confidence !== "confirmed" && (
              <span>
                {" "}
                ·{" "}
                {dependency.confidence === "inferred"
                  ? "Unconfirmed relationship"
                  : "Contradicted relationship"}
              </span>
            )}
            {dependency.version_scope && <p>Applies to: {dependency.version_scope}</p>}
            {dependency.note && <p>{dependency.note}</p>}
            {dependency.evidence_urls.map((url, index) => (
              <span key={url}>
                {" "}
                <ExternalLink href={url}>
                  {dependency.name} relationship source {index + 1} — {port.name}
                </ExternalLink>
              </span>
            ))}
          </li>
        ))}
      </ul>
      <p>Setup requirements and available actions are specific to each port and platform.</p>
    </details>
  );
}
