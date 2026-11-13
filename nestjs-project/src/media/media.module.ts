import { Module } from '@nestjs/common';
import { FfmpegRunner } from './ffmpeg.runner';
import { FfprobeRunner } from './ffprobe.runner';

/** FFmpeg/ffprobe access for the worker (phase-03-videos/TD-07). */
@Module({
  providers: [FfprobeRunner, FfmpegRunner],
  exports: [FfprobeRunner, FfmpegRunner],
})
export class MediaModule {}
