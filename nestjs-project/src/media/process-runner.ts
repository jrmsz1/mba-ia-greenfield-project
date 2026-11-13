import { spawn } from 'node:child_process';
import { MEDIA_TOOLS } from './media.constants';

export interface ToolRun {
  /** Exit code, or null when the process was killed. */
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * Runs a binary with a FIXED argument array — never through a shell, so no
 * object name or URL can inject a command (phase-03-videos/TD-07). A wall
 * clock timeout SIGKILLs the process; stdout/stderr are capped.
 */
export async function runTool(
  bin: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<ToolRun> {
  return await new Promise<ToolRun>((resolve, reject) => {
    const child = spawn(bin, [...args], {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length < MEDIA_TOOLS.MAX_STDOUT_BYTES) {
        stdout += chunk.toString('utf8');
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < MEDIA_TOOLS.MAX_STDERR_BYTES) {
        stderr += chunk.toString('utf8');
      }
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}
