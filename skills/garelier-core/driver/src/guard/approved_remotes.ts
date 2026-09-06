// Record-bound remote destinations for the Concierge external-operation seat.
// A destination is authority only as an exact (remote name, URL/path) pair; it
// never becomes a host wildcard or a generic network-egress exemption.

export interface ApprovedRemoteDestination {
  name: string;
  url: string;
}

const REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function parseApprovedRemoteSpec(spec: string): ApprovedRemoteDestination {
  const split = spec.indexOf("=");
  const name = split >= 0 ? spec.slice(0, split).trim() : "";
  const url = split >= 0 ? spec.slice(split + 1).trim() : "";
  if (!REMOTE_NAME.test(name) || !url) {
    throw new Error(
      `approved remote must be <name>=<url> with a git remote name and non-empty destination (got '${spec}')`,
    );
  }
  return { name, url };
}

export function normalizeApprovedRemoteDestinations(value: unknown): ApprovedRemoteDestination[] {
  if (!Array.isArray(value)) return [];
  const out: ApprovedRemoteDestination[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const raw = item as Record<string, unknown>;
    if (typeof raw.name !== "string" || typeof raw.url !== "string") continue;
    const name = raw.name.trim();
    const url = raw.url.trim();
    if (!REMOTE_NAME.test(name) || !url) continue;
    const key = `${name}\0${url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, url });
  }
  return out;
}

export function approvedUrlsFor(
  destinations: readonly ApprovedRemoteDestination[] | undefined,
  remote: string,
): string[] {
  return [...new Set(
    (destinations ?? [])
      .filter((destination) => destination.name === remote)
      .map((destination) => destination.url),
  )];
}
