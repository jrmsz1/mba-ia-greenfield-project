/**
 * Storage keys derive ONLY from the internal UUID primary key — never from the
 * public id or the client filename (phase-03-videos/TD-10).
 */
export function originalKey(videoId: string): string {
  return `videos/${videoId}/original`;
}

export function thumbnailKey(videoId: string): string {
  return `videos/${videoId}/thumbnail.jpg`;
}
