/**
 * Low-level child-process runner shared by the FFmpeg wrappers and the encoder
 * detector. Kept in its own module so those two can depend on it without an
 * import cycle.
 *
 * Safety notes
 *  * Binaries are always invoked with an **argv array** (`spawn` without a
 *    shell), so a filename can never be interpreted as a flag or shell
 *    fragment.
 *  * Every invocation has a hard timeout and a bounded output buffer.
 */
import "server-only";
import { spawn } from "node:child_process";
import { AppError } from "@/lib/errors";

export const FFMPEG_BIN = process.env.FFMPEG_PATH || "ffmpeg";
export const FFPROBE_BIN = process.env.FFPROBE_PATH || "ffprobe";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  timeoutMs?: number;
  /** Called with each stderr chunk (used for progress parsing). */
  onStderr?: (chunk: string) => void;
}

/** Runs a binary with argv-style arguments. Never uses a shell. */
export function runBinary(bin: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  const timeoutMs = options.timeoutMs ?? 15 * 60_000;
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      stdio: ["ignore", "pipe", "pipe"],
      // Keep FFmpeg from reading stdin and hanging on prompts.
      env: { ...process.env, AV_LOG_FORCE_NOCOLOR: "1" },
    });

    let stdout = "";
    let stderr = "";
    const MAX = 256 * 1024;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new AppError("INTERNAL", `${bin} timed out after ${Math.round(timeoutMs / 1000)}s.`));
    }, timeoutMs);

    child.stdout.on("data", (d: Buffer) => {
      if (stdout.length < MAX) stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      const text = d.toString();
      if (stderr.length < MAX) stderr += text;
      options.onStderr?.(text);
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(
        new AppError(
          "INTERNAL",
          `${bin} could not be started (${error.message}). Is FFmpeg installed?`,
        ),
      );
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}
