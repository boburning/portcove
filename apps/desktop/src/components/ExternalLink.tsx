import { useState, type ReactNode } from "react";
import { desktopApi } from "../api";
import { errorText } from "../view-model";

export function ExternalLink({ href, className, children }: { href: string; className?: string; children: ReactNode }) {
  const [error, setError] = useState<string>();
  const open = () => {
    setError(undefined);
    void desktopApi.openExternalUrl(href).catch(value => setError(errorText(value)));
  };
  return <>
    <a data-focusable href={href} className={className} onClick={event => { event.preventDefault(); open(); }}>{children}</a>
    {error && <span role="alert">Couldn’t open the browser: {error}</span>}
  </>;
}
