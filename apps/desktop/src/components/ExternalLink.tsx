import { cn } from "cn";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Trans } from "react-i18next";
import { desktopApi } from "../api";
import { useAppTranslation } from "../localization";
import { errorText } from "../view-model";
import { LatestRequestGeneration } from "../shared/concurrency-state";

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
  const [context, setContext] = useState({ href, openUrl });
  if (context.href !== href || context.openUrl !== openUrl) {
    setContext({ href, openUrl });
    setError(undefined);
  }
  const requests = useRef(new LatestRequestGeneration());
  useLayoutEffect(() => {
    const current = requests.current;
    return () => {
      current.begin();
    };
  }, [href, openUrl]);
  const { t } = useAppTranslation("common");
  const open = () => {
    const current = requests.current.begin();
    setError(undefined);
    void openUrl(href).catch((value) => {
      if (requests.current.isCurrent(current)) setError(errorText(value));
    });
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
