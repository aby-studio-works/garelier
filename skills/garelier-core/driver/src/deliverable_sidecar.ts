import { existsSync, readFileSync } from "node:fs";

export const DELIVERABLE_SIDECAR_SCHEMA_VERSION = 1;

export interface DeliverableSidecar {
  schemaVersion: 1;
  assignmentId: string | null;
  taskId: string | null;
  role: string | null;
  status: string | null;
  verdict: string | null;
  summary: string | null;
  commits: string[];
  filesChanged: string[];
  tests: Record<string, string>;
  riskFlags: Record<string, boolean>;
  needs: string[];
}

export function sidecarPathForMarkdown(markdownPath: string): string | null {
  return /\.md$/i.test(markdownPath) ? markdownPath.replace(/\.md$/i, ".json") : null;
}

export function readDeliverableSidecarForMarkdown(markdownPath: string): DeliverableSidecar | null {
  const sidecarPath = sidecarPathForMarkdown(markdownPath);
  if (!sidecarPath || !existsSync(sidecarPath)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(sidecarPath, "utf8"));
  } catch {
    return null;
  }
  return normalizeDeliverableSidecar(raw);
}

export function normalizeDeliverableSidecar(raw: unknown): DeliverableSidecar | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (Number(obj.schema_version) !== DELIVERABLE_SIDECAR_SCHEMA_VERSION) return null;
  const str = (v: unknown): string | null => {
    if (v == null) return null;
    const s = String(v).trim();
    return s ? s : null;
  };
  const strArr = (v: unknown): string[] =>
    Array.isArray(v) ? v.map(String).map((s) => s.trim()).filter(Boolean).slice(0, 30) : [];
  const strMap = (v: unknown): Record<string, string> => {
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    const out: Record<string, string> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>).slice(0, 20)) {
      const kk = k.trim();
      if (kk) out[kk] = String(val).trim().slice(0, 120);
    }
    return out;
  };
  const boolMap = (v: unknown): Record<string, boolean> => {
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    const out: Record<string, boolean> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>).slice(0, 20)) {
      const kk = k.trim();
      if (kk) out[kk] = val === true;
    }
    return out;
  };
  return {
    schemaVersion: DELIVERABLE_SIDECAR_SCHEMA_VERSION,
    assignmentId: str(obj.assignment_id),
    taskId: str(obj.task_id),
    role: str(obj.role),
    status: str(obj.status),
    verdict: str(obj.verdict),
    summary: str(obj.summary)?.slice(0, 500) ?? null,
    commits: strArr(obj.commits),
    filesChanged: strArr(obj.files_changed),
    tests: strMap(obj.tests),
    riskFlags: boolMap(obj.risk_flags),
    needs: strArr(obj.needs),
  };
}

export function deliverableSidecarSummary(sidecar: DeliverableSidecar): string {
  const parts: string[] = [];
  if (sidecar.verdict) parts.push(`verdict=${sidecar.verdict}`);
  else if (sidecar.status) parts.push(`status=${sidecar.status}`);
  if (sidecar.summary) parts.push(sidecar.summary);
  const tests = Object.entries(sidecar.tests)
    .slice(0, 4)
    .map(([k, v]) => `${k}:${v}`)
    .join(", ");
  if (tests) parts.push(`tests ${tests}`);
  const risks = Object.entries(sidecar.riskFlags)
    .filter(([, v]) => v)
    .map(([k]) => k)
    .slice(0, 4)
    .join(", ");
  if (risks) parts.push(`risks ${risks}`);
  if (sidecar.needs.length) parts.push(`needs ${sidecar.needs.slice(0, 4).join(", ")}`);
  return parts.join(" / ");
}
