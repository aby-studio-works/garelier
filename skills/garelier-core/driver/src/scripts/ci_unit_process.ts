import { parseBunTestReport } from "./ci_test_inventory.ts";

// Publish bytes as they arrive while retaining the decoded text for the report
// parser. Each stream keeps its own decoder so split UTF-8 survives chunking.
async function captureStream(stream: ReadableStream<Uint8Array>, publish: (bytes: Uint8Array) => void): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const text: string[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      publish(value);
      text.push(decoder.decode(value, { stream: true }));
    }
    text.push(decoder.decode());
    return text.join("");
  } finally {
    reader.releaseLock();
  }
}

export async function runUnit(name: string, files: readonly string[], cwd: string, args: readonly string[]) {
  process.stdout.write(`  --- ${name}: ${files.length} source file(s) ---\n`);
  const child = Bun.spawn([process.execPath, ...args, ...files], {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    captureStream(child.stdout, (bytes) => { process.stdout.write(bytes); }),
    captureStream(child.stderr, (bytes) => { process.stderr.write(bytes); }),
  ] as const);
  try {
    return { name, exitCode, stdout, stderr, report: parseBunTestReport(`${stdout}\n${stderr}`), parseError: "" };
  } catch (error) {
    return {
      name,
      exitCode,
      stdout,
      stderr,
      report: null,
      parseError: error instanceof Error ? error.message : String(error),
    };
  }
}
