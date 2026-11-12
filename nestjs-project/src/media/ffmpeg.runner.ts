import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { stat } from 'node:fs/promises';
import workerConfig from '../config/worker.config';
import { classifyToolFailure, MediaToolError } from './media-errors';
import { MEDIA_TOOLS } from './media.constants';
import { runTool } from './process-runner';

/**
 * `ffmpeg` single-frame extraction for the thumbnail (phase-03-videos/TD-07):
 * fixed arguments, input seek, one JPEG frame, wall-clock timeout. A frame
 * that cannot be decoded is a processing failure (TD-07 trade-offs), which
 * also catches files that pass ffprobe but are incomplete.
 */
@Injectable()
export class FfmpegRunner {
  constructor(
    @Inject(workerConfig.KEY)
    private readonly worker: ConfigType<typeof workerConfig>,
  ) {}

  async extractFrame(
    input: string,
    positionSeconds: number,
    outputFile: string,
  ): Promise<void> {
    const run = await runTool(
      MEDIA_TOOLS.FFMPEG_BIN,
      [
        '-nostdin',
        '-v',
        'error',
        '-rw_timeout',
        String(MEDIA_TOOLS.RW_TIMEOUT_MICROSECONDS),
        '-ss',
        positionSeconds.toFixed(3),
        '-i',
        input,
        '-frames:v',
        '1',
        '-q:v',
        String(MEDIA_TOOLS.THUMBNAIL_QUALITY),
        '-y',
        outputFile,
      ],
      this.worker.mediaProbeTimeoutSeconds * 1000,
    );
    if (run.timedOut) {
      throw new MediaToolError(
        'transient',
        'ffmpeg',
        `timed out after ${this.worker.mediaProbeTimeoutSeconds}s`,
      );
    }
    if (run.code !== 0) {
      throw new MediaToolError(
        classifyToolFailure(run.stderr),
        'ffmpeg',
        run.stderr.trim() || `exit code ${String(run.code)}`,
      );
    }
    const written = await stat(outputFile).catch(() => null);
    if (!written || written.size === 0) {
      throw new MediaToolError('permanent', 'ffmpeg', 'no frame decoded');
    }
  }
}
