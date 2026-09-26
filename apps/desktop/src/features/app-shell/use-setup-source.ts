import { useEffect, useRef, useState } from "react";
import type { SourceRecord } from "../../types";

export function useSetupSource(registeredSources: SourceRecord[]) {
  const [setupSource, setSetupSource] = useState<SourceRecord>();
  const observedRegistration = useRef(false);
  useEffect(() => {
    if (!setupSource) {
      observedRegistration.current = false;
      return;
    }
    if (
      registeredSources.some(
        (source) =>
          source.profile_id === setupSource.profile_id &&
          source.path === setupSource.path &&
          source.sha256 === setupSource.sha256,
      )
    )
      observedRegistration.current = true;
    else if (observedRegistration.current) setSetupSource(undefined);
  }, [registeredSources, setupSource]);
  return [setupSource, setSetupSource] as const;
}
