import { lineToOffset } from '@marky-mcmarkface/viewer-api';

/**
 * GitHub suggestions replace complete source lines, even when the reader selected only a word
 * in the rendered document. Seed the editor with exactly those lines so editing the suggestion
 * cannot accidentally erase Markdown syntax that was outside the visual selection.
 */
export function suggestionForLines(source: string, startLine: number, endLine: number): string {
  const first = Math.max(1, startLine);
  const last = Math.max(first, endLine);
  const start = lineToOffset(source, first);
  const after = lineToOffset(source, last + 1);
  const end = after > start && source.charCodeAt(after - 1) === 10 ? after - 1 : after;
  return source.slice(start, end);
}
