import { cn } from "cn";
import { useState, type ReactNode } from "react";
import { Trans } from "react-i18next";
import { desktopApi } from "../api";
import { useAppTranslation } from "../localization";
import { errorText } from "../view-model";

export function ExternalLink({
  href,
  className,
  children,
  openUrl = desktopApi.openExternalUrl,
}: {
  href: string;
  className?: string;
  children: ReactNode;
  openUrl?: (href: string) => Promise<void>;
}) {
  const [error, setError] = useState<string>();
  const { t } = useAppTranslation("common");
  const open = () => {
    setError(undefined);
    void openUrl(href).catch((value) => setError(errorText(value)));
  };
  return (
    <>
      <a
        data-focusable
        href={href}
        className={cn(
          "inline-flex items-center gap-1 justify-self-start font-medium text-pc-interactive-foreground underline-offset-4 hover:underline",
          className,
        )}
        onClick={(event) => {
          event.preventDefault();
          open();
        }}
      >
        {children}
      </a>
      {error && (
        <span role="alert">
          {/* The failure is exact Core or system text, never interpolated. */}
          <Trans t={t} i18nKey="browserFailed" components={{ detail: <bdi>{error}</bdi> }} />
        </span>
      )}
    </>
  );
}
