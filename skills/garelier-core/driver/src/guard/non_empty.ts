export type BoundaryString = string | null | undefined;

/** Reject an empty tool-boundary value without substituting a fallback. */
export function requireNonEmpty(value: BoundaryString, label: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

/** Convert an optional value to an argv fragment; empty values are omitted. */
export function optionalNonEmptyArg(value: BoundaryString): [] | [string] {
  const normalized = value?.trim();
  return normalized ? [normalized] : [];
}
