import { lineToOffset, type SourceRange } from '@marky-mcmarkface/viewer-api';

interface LineComment {
  line: number;
  startLine?: number | null;
  body: string;
  side?: SourceRange['side'];
}

function lineBounds(source: string, line: number): { start: number; end: number; after: number } {
  const start = lineToOffset(source, line);
  const after = lineToOffset(source, line + 1);
  const end = after > start && source.charCodeAt(after - 1) === 10 ? after - 1 : after;
  return { start, end, after };
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
  const { end: lineEnd, after: afterLastLine } = lineBounds(source, lastLine);

  const quote = leadingQuote(comment.body);
  if (quote) {
    const found = source.indexOf(quote, start);
    if (found !== -1 && found + quote.length <= Math.max(lineEnd, afterLastLine)) {
      return { side: comment.side ?? 'RIGHT', start: found, end: found + quote.length };
    }
  }

  if (source.slice(start, lineEnd).trim()) {
    return { side: comment.side ?? 'RIGHT', start, end: lineEnd };
  }

  /*
   * GitHub permits a thread on an empty diff line. Selecting that line's newline creates a real
   * DOM Selection, but paints no visible highlight — exactly what happened on product-strategy
   * #52, where a comment about the Tier 2/3 prose was attached to the blank line after it.
   * Prefer the nearest preceding prose line, matching how a margin note after a paragraph reads.
   */
  for (let line = firstLine - 1; line >= 1; line--) {
    const candidate = lineBounds(source, line);
    if (source.slice(candidate.start, candidate.end).trim()) {
      return { side: comment.side ?? 'RIGHT', start: candidate.start, end: candidate.end };
    }
  }

  // A file may begin with blank lines. In that case the first following prose is less surprising
  // than leaving the click with no visible response at all.
  for (let line = lastLine + 1; ; line++) {
    const candidate = lineBounds(source, line);
    if (candidate.start >= source.length) break;
    if (source.slice(candidate.start, candidate.end).trim()) {
      return { side: comment.side ?? 'RIGHT', start: candidate.start, end: candidate.end };
    }
  }

  return null;
}
