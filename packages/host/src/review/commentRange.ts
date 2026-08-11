import { lineToOffset, type SourceRange } from '@marky-mcmarkface/viewer-api';

interface LineComment {
  line: number;
  startLine?: number | null;
  body: string;
  side?: SourceRange['side'];
}

/** Recover the passage Marky writes at the start of a GitHub comment. */
export function leadingQuote(body: string): string | null {
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  if (!lines[0]?.startsWith('>')) return null;

  const quoted: string[] = [];
  for (const line of lines) {
    if (!line.startsWith('>')) break;
    quoted.push(line.replace(/^> ?/, ''));
  }
  return quoted.join('\n');
}

/**
 * Resolve a GitHub line comment back to source offsets.
 *
 * Marky-authored comments carry their selected source as a leading blockquote, which lets us
 * recover a character-precise range after GitHub has discarded the columns. Comments written
 * elsewhere have only GitHub's line span, so highlighting those lines is the honest fallback.
 */
export function commentRange(source: string, comment: LineComment): SourceRange | null {
  if (!source) return null;

  const firstLine = Math.max(1, comment.startLine ?? comment.line);
  const lastLine = Math.max(firstLine, comment.line);
  const start = lineToOffset(source, firstLine);
  const afterLastLine = lineToOffset(source, lastLine + 1);
  const lineEnd =
    afterLastLine > start && source.charCodeAt(afterLastLine - 1) === 10
      ? afterLastLine - 1
      : afterLastLine;

  const quote = leadingQuote(comment.body);
  if (quote) {
    const found = source.indexOf(quote, start);
    if (found !== -1 && found + quote.length <= Math.max(lineEnd, afterLastLine)) {
      return { side: comment.side ?? 'RIGHT', start: found, end: found + quote.length };
    }
  }

  // Blank lines have no selectable text. Include their newline when one exists so the viewer
  // can still expose a visible line-level anchor rather than returning a collapsed DOM Range.
  const end = lineEnd > start ? lineEnd : afterLastLine;
  if (end <= start) return null;
  return { side: comment.side ?? 'RIGHT', start, end };
}
