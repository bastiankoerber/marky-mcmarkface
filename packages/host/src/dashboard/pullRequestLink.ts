export interface PullRequestReference {
  owner: string;
  repo: string;
  number: number;
}

/**
 * Find a GitHub pull request in either a copied URL/message or the compact owner/repo#123 form.
 *
 * Accepting surrounding text is intentional: Slack may put a URL behind link text, but copying
 * the whole message is often quicker than carefully selecting just the link.
 */
export function parsePullRequestReference(value: string): PullRequestReference | null {
  const githubUrl =
    /https?:\/\/(?:www\.)?github\.com\/([a-z0-9_.-]+)\/([a-z0-9_.-]+)\/pull\/(\d+)(?=$|[/?#\s>|])/i.exec(
      value,
    );
  if (githubUrl) return reference(githubUrl[1], githubUrl[2], githubUrl[3]);

  const shorthand = /^\s*([a-z0-9_.-]+)\/([a-z0-9_.-]+)\s*#\s*(\d+)\s*$/i.exec(value);
  if (shorthand) return reference(shorthand[1], shorthand[2], shorthand[3]);

  return null;
}

function reference(
  owner: string | undefined,
  repo: string | undefined,
  rawNumber: string | undefined,
): PullRequestReference | null {
  if (!owner || !repo || !rawNumber) return null;
  const number = Number(rawNumber);
  if (!Number.isSafeInteger(number) || number < 1) return null;
  return { owner, repo, number };
}
