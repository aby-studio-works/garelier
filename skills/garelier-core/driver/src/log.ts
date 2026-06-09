// Structured logger. Writes both human-readable lines to stdout and JSONL records
// to per-role / global log files under __garelier/<pm_id>/runtime/driver/logs/.
//
// Output is intentionally minimal — one line per action — so the live driver
// terminal stays scannable. Detailed payloads (full model responses, tool
// inputs/outputs) go to the JSONL files for forensic review.

import { appendFileSync, mkdirSync, statSync, renameSync, rmSync, existsSync } from "node:fs";
import { dirname } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogRecord {
  ts: string;
  level: LogLevel;
  source: string; // "driver" | role label like "dock" / "worker-worker-01"
  event: string;
  [k: string]: unknown;
}

// DEC-028: size-based rotation so a long-running driver's JSONL logs don't grow
// unbounded. When the active file passes maxBytes it is rolled to `.1`, `.1`→`.2`,
// …, and anything past keepFiles is dropped.
export interface LogRotationConfig {
  maxBytes: number;
  keepFiles: number;
}

export class Logger {
  constructor(
    private readonly source: string,
    private readonly jsonlPath?: string,
    private readonly rotation?: LogRotationConfig,
  ) {
    if (jsonlPath) mkdirSync(dirname(jsonlPath), { recursive: true });
  }

  child(source: string, jsonlPath?: string, rotation?: LogRotationConfig): Logger {
    return new Logger(source, jsonlPath ?? this.jsonlPath, rotation ?? this.rotation);
  }

  // Roll the active file when it exceeds maxBytes. Best-effort: a rotation
  // failure logs to stderr but never blocks the driver.
  private maybeRotate(): void {
    const path = this.jsonlPath;
    const rot = this.rotation;
    if (!path || !rot || rot.maxBytes <= 0) return;
    let size = 0;
    try {
      size = statSync(path).size;
    } catch {
      return; // file does not exist yet → nothing to rotate
    }
    if (size < rot.maxBytes) return;
    try {
      const keep = Math.max(1, Math.floor(rot.keepFiles));
      try { rmSync(`${path}.${keep}`, { force: true }); } catch { /* ignore */ }
      for (let i = keep - 1; i >= 1; i--) {
        if (existsSync(`${path}.${i}`)) {
          try { renameSync(`${path}.${i}`, `${path}.${i + 1}`); } catch { /* ignore */ }
        }
      }
      renameSync(path, `${path}.1`);
    } catch (e) {
      console.error(`[log] failed to rotate ${path}:`, e);
    }
  }

  private emit(level: LogLevel, event: string, extra: Record<string, unknown> = {}): void {
    const ts = new Date().toISOString();
    const record: LogRecord = { ts, level, source: this.source, event, ...extra };

    // Human-readable to stdout (skip noisy debug unless DEBUG=1)
    if (level !== "debug" || process.env.DEBUG === "1") {
      const extras = Object.entries(extra)
        .map(([k, v]) => `${k}=${formatValue(v)}`)
        .join(" ");
      const tag = level === "info" ? "" : `[${level.toUpperCase()}] `;
      console.log(`[${ts}] ${tag}${this.source}: ${event}${extras ? " " + extras : ""}`);
    }

    // Structured to JSONL
    if (this.jsonlPath) {
      try {
        this.maybeRotate();
        appendFileSync(this.jsonlPath, JSON.stringify(record) + "\n", "utf8");
      } catch (e) {
        console.error(`[log] failed to write ${this.jsonlPath}:`, e);
      }
    }
  }

  debug(event: string, extra?: Record<string, unknown>): void { this.emit("debug", event, extra); }
  info(event: string, extra?: Record<string, unknown>): void { this.emit("info", event, extra); }
  warn(event: string, extra?: Record<string, unknown>): void { this.emit("warn", event, extra); }
  error(event: string, extra?: Record<string, unknown>): void { this.emit("error", event, extra); }
}

function formatValue(v: unknown): string {
  if (v === null || v === undefined) return String(v);
  if (typeof v === "string") {
    return v.length > 80 ? JSON.stringify(v.slice(0, 77) + "...") : JSON.stringify(v);
  }
  if (typeof v === "object") {
    const s = JSON.stringify(v);
    return s.length > 120 ? s.slice(0, 117) + "..." : s;
  }
  return String(v);
}
