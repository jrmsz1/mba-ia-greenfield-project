import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import workerConfig from '../config/worker.config';
import { classifyToolFailure, MediaToolError } from './media-errors';
import { MEDIA_TOOLS } from './media.constants';
import { runTool } from './process-runner';

/** The subset of `ffprobe -of json` output the media rule reads. */
export interface ProbeStream {
  index?: number;
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  pix_fmt?: string;
}

export interface ProbeResult {
  format?: {
    format_name?: string;
    duration?: string;
    size?: string;
    bit_rate?: string;
    tags?: { major_brand?: string };
  };
  streams?: ProbeStream[];
}

/**
 * `ffprobe` over the presigned input (phase-03-videos/TD-07, TD-08): fixed
 * arguments, bounded probing, `-rw_timeout` in microseconds and a wall-clock
 * timeout. Failures are classified by stderr, never by exit code.
 */
@Injectable()
export class FfprobeRunner {
  constructor(
    @Inject(workerConfig.KEY)
    private readonly worker: ConfigType<typeof workerConfig>,
  ) {}

  async probe(input: string): Promise<ProbeResult> {
    const run = await runTool(
      MEDIA_TOOLS.FFPROBE_BIN,
      [
        '-v',
        'error',
        '-rw_timeout',
        String(MEDIA_TOOLS.RW_TIMEOUT_MICROSECONDS),
        '-probesize',
        String(MEDIA_TOOLS.PROBESIZE_BYTES),
        '-analyzeduration',
        String(MEDIA_TOOLS.ANALYZEDURATION_MICROSECONDS),
        '-show_entries',
        'format=format_name,duration,size,bit_rate:format_tags=major_brand:stream=index,codec_type,codec_name,width,height,pix_fmt',
        '-of',
        'json',
        input,
      ],
      this.worker.mediaProbeTimeoutSeconds * 1000,
    );
    if (run.timedOut) {
      throw new MediaToolError(
        'transient',
        'ffprobe',
        `timed out after ${this.worker.mediaProbeTimeoutSeconds}s`,
      );
    }
    if (run.stderr.trim() !== '' || run.code !== 0) {
      // `-v error` prints only errors: any stderr means the probe failed.
      throw new MediaToolError(
        classifyToolFailure(run.stderr),
        'ffprobe',
        run.stderr.trim() || `exit code ${String(run.code)}`,
      );
    }
    try {
      return JSON.parse(run.stdout) as ProbeResult;
    } catch {
      throw new MediaToolError('permanent', 'ffprobe', 'unreadable output');
    }
  }
}
