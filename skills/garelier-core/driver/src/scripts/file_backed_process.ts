import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { rmSync } from "../guard/path_guard.ts";

export interface FileBackedProcessOptions {
  command: string[];
  captureRoot: string;
  capturePrefix: string;
  cwd?: string;
  env?: Record<string, string | undefined>;
  stdin?: Uint8Array | "ignore";
  onSpawn?: (process: Bun.Subprocess) => void;
  /** Poll while the direct child is alive. The caller can inspect capture-file
   * growth without consuming or duplicating the eventual output. */
  onCapturePoll?: () => void;
  onOutput?: (stdout: string, stderr: string) => void;
}

export interface FileBackedProcessResult<T> {
  result: T;
  stdout: string;
  stderr: string;
}

/**
 * Run a child with stdout/stderr attached to run-owned files.
 *
 * Completion depends only on `waitForExit`, normally `process.exited`; a
 * longer-lived grandchild can retain the file descriptors without retaining a
 * pipe whose EOF the caller must consume (W-421/W-453). A bounded poll hook can
 * observe file growth while that child is alive; the files are read after the
 * direct child finishes and removed after `onOutput`, including exceptional
 * paths.
 */
export async function runFileBackedProcess<T>(
  options: FileBackedProcessOptions,
  waitForExit: (process: Bun.Subprocess) => Promise<T>,
): Promise<FileBackedProcessResult<T>> {
  if (
    !/^[A-Za-z0-9._-]+$/.test(options.capturePrefix)
    || options.capturePrefix === "."
    || options.capturePrefix === ".."
  ) {
    throw new Error(`invalid file-backed process capture prefix: ${options.capturePrefix}`);
  }

  const captureRoot = resolve(options.captureRoot);
  mkdirSync(captureRoot, { recursive: true });
  const captureDir = mkdtempSync(resolve(captureRoot, options.capturePrefix));
  const stdoutPath = resolve(captureDir, "stdout");
  const stderrPath = resolve(captureDir, "stderr");
  let stdoutFd: number | undefined;
  let stderrFd: number | undefined;
  let stdout = "";
  let stderr = "";
  let result!: T;
  let polling = false;
  let pollError: unknown;
  let pollTask: Promise<void> | undefined;
  let wakePoll: (() => void) | undefined;

  try {
    stdoutFd = openSync(stdoutPath, "w");
    stderrFd = openSync(stderrPath, "w");
    const child = Bun.spawn(options.command, {
      windowsHide: true,
      cwd: options.cwd,
      env: options.env,
      stdin: options.stdin ?? "ignore",
      stdout: stdoutFd,
      stderr: stderrFd,
    });
    options.onSpawn?.(child);
    if (options.onCapturePoll) {
      polling = true;
      pollTask = (async () => {
        while (polling) {
          await new Promise<void>((resolvePoll) => {
            const timer = setTimeout(resolvePoll, 250);
            wakePoll = () => {
              clearTimeout(timer);
              resolvePoll();
            };
          });
          wakePoll = undefined;
          if (!polling) break;
          try {
            options.onCapturePoll?.();
          } catch (error) {
            pollError = error;
            try { child.kill("SIGKILL"); } catch { /* child already exited */ }
            break;
          }
        }
      })();
    }
    try {
      result = await waitForExit(child);
    } finally {
      polling = false;
      wakePoll?.();
      await pollTask;
    }
    if (pollError) throw pollError;
  } finally {
    if (stdoutFd !== undefined) closeSync(stdoutFd);
    if (stderrFd !== undefined) closeSync(stderrFd);
    try {
      if (existsSync(stdoutPath)) stdout = readFileSync(stdoutPath, "utf8");
      if (existsSync(stderrPath)) stderr = readFileSync(stderrPath, "utf8");
      options.onOutput?.(stdout, stderr);
    } finally {
      rmSync(captureDir, { recursive: true, force: true });
    }
  }

  return { result, stdout, stderr };
}
