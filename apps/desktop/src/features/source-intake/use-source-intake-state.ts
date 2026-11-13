import { useCallback, useState } from "react";
import { gameIdentityLabel } from "../../port-identity";
import type { SourceIntakeRequest } from "../../components/SourceIntake";
import type { CatalogDocument } from "../../types";

export function useSourceIntakeState(catalog: CatalogDocument | undefined, generation: number) {
  const [request, setRequest] = useState<SourceIntakeRequest>();
  const open = useCallback(
    (portId: string, profileId: string, paths: string[] = []) => {
      const port = catalog?.ports.find((candidate) => candidate.id === portId);
      const profile = catalog?.source_profiles?.find((candidate) => candidate.id === profileId);
      if (port && profile)
        setRequest({
          generation,
          portId,
          portName: gameIdentityLabel(port),
          profile,
          purpose: port.bios_source_profile === profileId ? "bios" : "game",
          paths,
        });
    },
    [catalog, generation],
  );
  const close = useCallback(() => setRequest(undefined), []);
  return { request: request?.generation === generation ? request : undefined, open, close };
}
