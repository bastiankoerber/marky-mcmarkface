export interface BranchReference {
  owner: string;
  repo: string;
  branch: string;
}

/** Parse a GitHub branch URL or the unambiguous owner/repo@branch shorthand. */
export function parseBranchReference(input: string): BranchReference | null {
  const shorthand = /^\s*([^\s/@]+)\/([^\s/@]+)\s*@\s*(\S+?)\s*$/.exec(input);
  if (shorthand) return { owner: shorthand[1]!, repo: shorthand[2]!, branch: shorthand[3]! };

  const match = /https:\/\/github\.com\/([^\s/<>|]+)\/([^\s/<>|]+)\/tree\/([^\s<>|?#]+)/i.exec(input);
  if (!match) return null;
  try {
    return {
      owner: decodeURIComponent(match[1]!),
      repo: decodeURIComponent(match[2]!),
      branch: match[3]!.split('/').map(decodeURIComponent).join('/'),
    };
  } catch {
    return null;
  }
}
