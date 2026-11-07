export function applicationOpportunityFromRunTitle(title: unknown) {
  if (typeof title !== "string") return undefined;
  return (
    /^Application ([a-f0-9]{40})(?: wake [1-9][0-9]{0,15})?$/u.exec(title)?.[1] ??
    /^Application ([a-f0-9]{64})$/u.exec(title)?.[1]
  );
}
