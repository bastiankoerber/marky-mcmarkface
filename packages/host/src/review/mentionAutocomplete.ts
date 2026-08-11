export interface MentionQuery {
  start: number;
  end: number;
  query: string;
}

/**
 * Find the @-mention currently being typed at the caret.
 *
 * Requiring whitespace (or opening punctuation) before the @ keeps email addresses from
 * unexpectedly opening the autocomplete menu. The end extends across the rest of the username
 * so choosing a completion also works when the caret was moved back into an existing mention.
 */
export function mentionQueryAt(value: string, caret: number): MentionQuery | null {
  const before = value.slice(0, caret);
  const match = /(?:^|[\s([{])@([a-z\d-]*)$/i.exec(before);
  if (!match) return null;

  const start = match.index + match[0].lastIndexOf('@');
  let end = caret;
  while (end < value.length && /[a-z\d-]/i.test(value[end]!)) end += 1;
  return { start, end, query: match[1] ?? '' };
}

export function completeMention(
  value: string,
  mention: Pick<MentionQuery, 'start' | 'end'>,
  login: string,
): { value: string; caret: number } {
  const replacement = `@${login}`;
  const after = value.slice(mention.end);
  const spacer = after.length === 0 || !/^[\s.,!?;:)\]}]/.test(after) ? ' ' : '';
  return {
    value: value.slice(0, mention.start) + replacement + spacer + after,
    caret: mention.start + replacement.length + spacer.length,
  };
}
