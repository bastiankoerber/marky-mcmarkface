export interface BranchReference {
  owner: string;
  repo: string;
  branch: string;
  file?: string;
}

/** Parse a GitHub branch URL or the unambiguous owner/repo@branch shorthand. */
export function parseBranchReference(input: string): BranchReference | null {
  const shorthand = /^\s*([^\s/@]+)\/([^\s/@]+)\s*@\s*(\S+?)\s*$/.exec(input);
  if (shorthand) return { owner: shorthand[1]!, repo: shorthand[2]!, branch: shorthand[3]! };

  const match = /https:\/\/github\.com\/([^\s/<>|]+)\/([^\s/<>|]+)\/(tree|blob)\/([^\s<>|?#]+)/i.exec(input);
  if (!match) return null;
  try {
    const tail = match[4]!.split('/').map(decodeURIComponent);
    if (match[3] === 'blob' && tail.length < 2) return null;
    return {
      owner: decodeURIComponent(match[1]!),
      repo: decodeURIComponent(match[2]!),
      branch: match[3] === 'blob' ? tail[0]! : tail.join('/'),
      ...(match[3] === 'blob' ? { file: tail.slice(1).join('/') } : {}),
    };
  } catch {
    return null;
  }
}
