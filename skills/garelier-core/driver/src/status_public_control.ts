import { Buffer } from "node:buffer";
import { redact } from "./status_snapshot.ts";

const LIMITS = {
  text: 1_000,
} as const;

function stripSensitiveUrls(value: string): string {
  return value.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"']+/gi, (raw) => {
    try {
      const url = new URL(raw);
      const port = url.port ? `:${url.port}` : "";
      return `${url.protocol}//${url.hostname}${port}${url.pathname}`;
    } catch { return "[external-uri]"; }
  });
}

export function statusText(value: unknown, max: number = LIMITS.text): string {
  let out = redact(String(value ?? ""));
  out = stripSensitiveUrls(out)
    .replace(/\bfile:\/\/\S+/gi, "[local-path]")
    .replace(/\b[A-Za-z]:[\\/][^\s<>"']+/g, "[local-path]")
    .replace(/(^|[\s("'`])\/(?:Users|home|tmp|private|var|etc|opt|root|mnt|workspace)(?:\/[^\s<>"']*)?/gi, "$1[local-path]")
    .replace(/javascript\s*:/gi, "[unsafe-scheme]:")
    .replace(/[<>]/g, (char) => char === "<" ? "‹" : "›")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/[\r\n\t]+/g, " ")
    .trim();
  const encoded = Buffer.from(out, "utf8");
  if (encoded.byteLength <= max) return out;
  let end = max;
  while (end > 0 && (encoded[end] & 0xc0) === 0x80) end -= 1;
  return encoded.subarray(0, end).toString("utf8");
}

export const PUBLIC_STATUS_LIMITS = LIMITS;
