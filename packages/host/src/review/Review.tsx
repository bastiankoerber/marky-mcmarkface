import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { offsetToLine, quoteFor, type AnchoringImpl, type SourceRange, type ViewerHost } from '@marky-mcmarkface/viewer-api';
import { api, type PrDetail, type RepositoryFile, type ReviewEvent } from '../api.js';
import { createRegistry } from '../viewers/index.js';
import { Loading } from '../Loading.jsx';
import { FileTree } from './FileTree.jsx';
import { CommentRail, type RailPending, type RailThread } from './CommentRail.jsx';
import { commentRange } from './commentRange.js';
import { findDocumentText } from './documentSearch.js';
import { clearDrafts, loadDrafts, saveDrafts, type LocalComment, type ReviewId } from './draftStore.js';
import { resolveReviewImageUrl } from './imageUrl.js';
import { resolveRepositoryLink } from './repositoryLink.js';
import { suggestionForLines } from './suggestion.js';

type Mode = 'rich' | 'final' | 'source';

interface Draft {
  range: SourceRange;
  startLine: number;
  line: number;
  quote: string;
  commentable: boolean;
  suggestion: string;
}

let commentSeq = 0;
const nextCommentId = () => `c${++commentSeq}`;

export function Review({
  owner,
  repo,
  number,
  branch,
  initialPath,
  theme,
  onBack,
  onPathChange,
  onPullRequestCreated,
}: {
  owner: string;
  repo: string;
  number: number | null;
  branch: string | null;
  initialPath: string | null;
  /** Resolved, never 'system' — a viewer has to know which way to draw. */
  theme: 'light' | 'dark';
  onBack: () => void;
  onPathChange: (path: string) => void;
  onPullRequestCreated: (number: number) => void;
}) {
  const branchReview = number === null && branch !== null;
  const reviewId: ReviewId = number ?? `branch:${branch!}`;
  const [pr, setPr] = useState<PrDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [referenceFile, setReferenceFile] = useState<RepositoryFile | null>(null);
  const [referenceLoading, setReferenceLoading] = useState<string | null>(null);
  const [navigationError, setNavigationError] = useState<{ path: string; message: string } | null>(null);
  const [mode, setMode] = useState<Mode>('rich');
  const [viewed, setViewed] = useState<Set<string>>(new Set());
  // `[` and `]` collapse the tree and the rail, the way Readwise Reader does it.
  // With both hidden the document becomes pure marginalia — just the page.
  const [showTree, setShowTree] = useState(true);
  const [showRail, setShowRail] = useState(true);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchIndex, setSearchIndex] = useState(-1);
  const [searchCount, setSearchCount] = useState(0);

  const [draft, setDraft] = useState<Draft | null>(null);
  const [draftBody, setDraftBody] = useState('');
  const [draftKind, setDraftKind] = useState<'comment' | 'suggestion'>('comment');
  const [draftSuggestion, setDraftSuggestion] = useState('');
  const [pending, setPending] = useState<LocalComment[]>([]);
  const [summary, setSummary] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState<string | null>(null);
  const [createdNumber, setCreatedNumber] = useState<number | null>(null);
  const [pullRequestTitle, setPullRequestTitle] = useState('');
  const [railTick, setRailTick] = useState(0);
  const [draftNotice, setDraftNotice] = useState<string | null>(null);
  // Nothing may be written back until the stored buffer has been read, or the first save
  // (with an empty buffer) erases exactly what we are about to restore.
  const restored = useRef(false);
  const navigationSeq = useRef(0);
  const documentRootRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchMatchesRef = useRef<Range[]>([]);
  const searchIndexRef = useRef(-1);

  const anchoringRef = useRef<AnchoringImpl | null>(null);
  const registry = useMemo(() => createRegistry(), []);

  const openSearch = useCallback(() => {
    setSearchOpen(true);
    requestAnimationFrame(() => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    });
  }, []);

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    searchInputRef.current?.blur();
  }, []);

  const stepSearch = useCallback((direction: 1 | -1) => {
    const ranges = searchMatchesRef.current;
    if (!ranges.length) return;
    const next = (searchIndexRef.current + direction + ranges.length) % ranges.length;
    searchIndexRef.current = next;
    setSearchIndex(next);
    const doc = documentRootRef.current?.ownerDocument;
    if (doc) paintSearchResults(doc, ranges, next);
    scrollSearchResultIntoView(ranges[next]!, documentRootRef.current);
  }, []);

  useEffect(() => {
    let live = true;
    restored.current = false;
    setPr(null);
    setError(null);
    const request = branchReview ? api.branch(owner, repo, branch!) : api.pr(owner, repo, number!);
    request
      .then((data) => {
        if (!live) return;
        setPr(data);

        // Unsent comments outlive a reload. They only exist in this tab until you submit, and
        // losing an afternoon of margin notes to a refresh is not a reasonable price for that.
        if (branchReview) setPullRequestTitle(defaultPullRequestTitle(branch!));
        const { buffer, stale } = loadDrafts(owner, repo, reviewId, data.headSha);
        if (buffer) {
          // Re-id on restore: the module counter restarts at c1 on every load, so reusing the
          // stored ids would collide with the next comment written in this session.
          setPending(buffer.comments.map((c) => ({ ...c, id: nextCommentId() })));
          setSummary(buffer.summary);
          const n = buffer.comments.length;
          setDraftNotice(`Restored ${n} unsent comment${n === 1 ? '' : 's'} from your last visit.`);
        } else if (stale > 0) {
          setDraftNotice(
            `${stale} unsent comment${stale === 1 ? ' was' : 's were'} discarded: new commits have been pushed since ` +
              `${stale === 1 ? 'it was' : 'they were'} written, so the lines no longer match.`,
          );
        }
        restored.current = true;
      })
      .catch((err) => live && setError((err as Error).message));
    return () => {
      live = false;
    };
  }, [owner, repo, number, branch, branchReview, reviewId]);

  useEffect(() => {
    if (!restored.current || !pr) return;
    saveDrafts(owner, repo, reviewId, { headSha: pr.headSha, summary, comments: pending });
  }, [pending, summary, pr, owner, repo, reviewId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        openSearch();
        return;
      }
      if (searchOpen && e.key === 'Escape') {
        e.preventDefault();
        closeSearch();
        return;
      }
      if (searchOpen && e.key === 'Enter' && e.target === searchInputRef.current) {
        e.preventDefault();
        stepSearch(e.shiftKey ? -1 : 1);
        return;
      }
      // Never steal the key while someone is writing a comment.
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === '[') setShowTree((v) => !v);
      if (e.key === ']') setShowRail((v) => !v);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [closeSearch, openSearch, searchOpen, stepSearch]);

  useEffect(() => {
    const root = documentRootRef.current;
    if (!searchOpen || !root) {
      searchMatchesRef.current = [];
      setSearchCount(0);
      setSearchIndex(-1);
      searchIndexRef.current = -1;
      clearSearchResults(document);
      return;
    }

    const refresh = () => {
      const ranges = findDocumentText(root, searchQuery);
      searchMatchesRef.current = ranges;
      setSearchCount(ranges.length);
      const first = ranges.length ? 0 : -1;
      setSearchIndex(first);
      searchIndexRef.current = first;
      paintSearchResults(root.ownerDocument, ranges, first);
      if (first >= 0) scrollSearchResultIntoView(ranges[first]!, root);
    };

    refresh();
    return () => {
      clearSearchResults(root.ownerDocument);
    };
  }, [activePath, mode, railTick, searchOpen, searchQuery]);

  const openPath = useCallback(
    (path: string, updateRoute = true) => {
      if (!pr) return false;
      const request = ++navigationSeq.current;
      setActivePath(path);
      setDraft(null);
      setNavigationError(null);

      const changed = pr.files.find((candidate) => candidate.path === path);
      if (changed) {
        setReferenceFile(null);
        setReferenceLoading(null);
      } else {
        setReferenceFile(null);
        setReferenceLoading(path);
        const requestFile = branchReview
          ? api.branchFile(owner, repo, branch!, path)
          : api.repositoryFile(owner, repo, number!, path);
        void requestFile
          .then((loaded) => {
            if (navigationSeq.current !== request) return;
            setReferenceFile(loaded);
            setReferenceLoading(null);
          })
          .catch((error) => {
            if (navigationSeq.current !== request) return;
            setReferenceLoading(null);
            setNavigationError({ path, message: (error as Error).message });
          });
      }

      if (updateRoute) onPathChange(path);
      return true;
    },
    [branch, branchReview, number, onPathChange, owner, pr, repo],
  );

  useEffect(() => {
    if (!pr) return;
    const requested =
      initialPath ?? pr.files.find((candidate) => /\.mdx?$/i.test(candidate.path))?.path ?? pr.files[0]?.path;
    if (!requested) return;
    const alreadyOpening =
      activePath === requested &&
      (pr.files.some((candidate) => candidate.path === requested) ||
        referenceFile?.path === requested ||
        referenceLoading === requested ||
        navigationError?.path === requested);
    if (!alreadyOpening) openPath(requested, false);
  }, [activePath, initialPath, navigationError?.path, openPath, pr, referenceFile?.path, referenceLoading]);

  const changedFile = pr?.files.find((candidate) => candidate.path === activePath) ?? null;
  const referenceDisplay = useMemo<PrDetail['files'][number] | null>(
    () =>
      referenceFile?.path === activePath
        ? {
            path: referenceFile.path,
            previousPath: null,
            status: 'unchanged',
            additions: 0,
            deletions: 0,
            patch: { hunks: [], rightLines: [], leftLines: [] },
            base: referenceFile.content,
            head: referenceFile.content,
            skipped: null,
          }
        : null,
    [activePath, referenceFile],
  );
  const file = changedFile ?? referenceDisplay;
  const readOnlyReference = Boolean(referenceDisplay);
  const headSource = file?.head ?? '';

  const registerAnchoring = useCallback((impl: AnchoringImpl | null) => {
    anchoringRef.current = impl;
    // Threads can only be placed once a viewer has rendered and told us how to anchor.
    setRailTick((t) => t + 1);
  }, []);

  /** GitHub rejects any comment on a line outside the diff, so check before offering to comment. */
  const commentableAt = useCallback(
    (from: number, to: number) => {
      const ranges = file?.patch.rightLines ?? [];
      for (let line = from; line <= to; line++) {
        if (!ranges.some(([lo, hi]) => line >= lo && line <= hi)) return false;
      }
      return true;
    },
    [file],
  );

  const host = useMemo<ViewerHost>(
    () => ({
      onSelect: (range) => {
        if (readOnlyReference || !range || !headSource) {
          setDraft(null);
          return;
        }
        const startLine = offsetToLine(headSource, range.start).line;
        const line = offsetToLine(headSource, Math.max(range.start, range.end - 1)).line;
        setDraft({
          range,
          startLine,
          line,
          quote: quoteFor(headSource, range).exact.slice(0, 300),
          commentable: commentableAt(startLine, line),
          suggestion: suggestionForLines(headSource, startLine, line),
        });
        setDraftBody('');
        setDraftKind('comment');
        setDraftSuggestion(suggestionForLines(headSource, startLine, line));
      },
      commentableRanges: () => (readOnlyReference ? [] : (file?.patch.rightLines ?? [])),
      requestComment: () => {},
      resolveImageUrl: (source, documentPath) =>
        resolveReviewImageUrl(source, documentPath, pr?.imageBaseUrl),
      openLink: (href, documentPath) => {
        const target = resolveRepositoryLink(href, documentPath);
        return target ? openPath(target.path) : false;
      },
      theme,
    }),
    [headSource, commentableAt, file, openPath, pr?.imageBaseUrl, readOnlyReference, theme],
  );

  const addComment = () => {
    if (!draft || !file || readOnlyReference) return;
    const isSuggestion = draft.commentable && draftKind === 'suggestion';
    if (isSuggestion ? draftSuggestion === draft.suggestion : !draftBody.trim()) return;
    setPending((prev) => [
      ...prev,
      {
        id: nextCommentId(),
        path: file.path,
        side: 'RIGHT',
        line: draft.line,
        ...(draft.startLine < draft.line ? { startLine: draft.startLine } : {}),
        // An unchanged passage still gets recorded, just attached to the file rather than a
        // line. The quote in the body is what tells the author which passage was meant.
        ...(draft.commentable ? {} : { subjectType: 'file' as const }),
        body: `> ${draft.quote.replace(/\n/g, '\n> ')}\n\n${draftBody.trim()}`,
        ...(isSuggestion ? { suggestion: draftSuggestion } : {}),
        range: draft.range,
      },
    ]);
    setDraft(null);
    setDraftBody('');
    setDraftKind('comment');
    setDraftSuggestion('');
    window.getSelection()?.removeAllRanges();
  };

  const submit = async (event: ReviewEvent) => {
    if (!pr) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      if (branchReview) {
        const result = await api.createPullRequest(owner, repo, {
          branch: branch!,
          expectedHeadSha: pr.headSha,
          title: pullRequestTitle,
          body: summary,
          comments: pending.map(({ id: _id, range: _range, ...comment }) => comment),
        });
        clearDrafts(owner, repo, reviewId);
        setPending([]);
        setSummary('');
        setSubmitted(result.url);
        setCreatedNumber(result.number);
        if (result.reviewError) setSubmitError(result.reviewError);
        return;
      }
      const result = await api.submitReview(owner, repo, number!, {
        event,
        body: summary,
        commitId: pr.headSha,
        // Strip local-only annotation metadata; neither field has meaning to GitHub.
        comments: pending.map(({ id: _id, range: _range, ...comment }) => comment),
      });
      setPending([]);
      setSummary('');
      setSubmitted(result.url);
      // File-level comments are posted after the review, so they can fail on their own. Say
      // which ones rather than reporting a clean success that was not one.
      if (result.fileCommentErrors?.length) {
        setSubmitError(
          `The review was submitted, but ${result.fileCommentErrors.length} file comment(s) failed: ${result.fileCommentErrors.join('; ')}`,
        );
      }
      setPr(await api.pr(owner, repo, number!));
    } catch (err) {
      setSubmitError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  // Place rail cards next to the prose they refer to, by asking the viewer to anchor each one.
  const { railPending, railThreads, archivedThreads, topForLine } = useMemo(() => {
    void railTick;
    const impl = anchoringRef.current;
    const container = impl?.contentContainer();
    const scroller = container?.closest('[data-marky-mcmarkface-scroll]') ?? null;

    /*
     * Where a card sits, in the scroll container's own content space.
     *
     * Measured from the *scroller*, not from the rendered document, because the rail's
     * coordinate origin is the top of the scrolled content — measuring from the document
     * instead put every card a constant ~66px too high, the document's padding.
     *
     * `scrollTop` and the scroller's rect are read **inside** this function, on purpose. They
     * used to be hoisted into the enclosing memo, which meant they froze at whatever the scroll
     * position was when the memo last ran. Selecting text does not invalidate that memo, so a
     * reader who scrolled down and then highlighted a phrase got a card placed using the *old*
     * scroll offset against a *current* rect — landing it exactly `scrollTop` pixels away, on
     * some unrelated paragraph. Read them live and the two always agree.
     */
    const topFor = (line: number): number => {
      if (!impl || !headSource || !scroller) return line * 22;
      const offset = lineOffset(headSource, line);
      const anchored = impl.anchor({ side: 'RIGHT', start: offset, end: offset + 1 });
      if (!anchored) return line * 22;
      const rect = 'getBoundingClientRect' in anchored ? anchored.getBoundingClientRect() : null;
      if (!rect) return line * 22;
      return rect.top - scroller.getBoundingClientRect().top + scroller.scrollTop;
    };

    return {
      topForLine: topFor,
      railPending: pending
        .filter((c) => c.path === activePath)
        .map<RailPending>((c) => ({
          key: c.id,
          path: c.path,
          startLine: c.startLine ?? c.line,
          line: c.line,
          body: c.body.replace(/^> .*\n\n/s, ''),
          ...(c.suggestion === undefined ? {} : { suggestion: c.suggestion }),
          quote: c.body.startsWith('>') ? (c.body.split('\n\n')[0] ?? '').replace(/^> /gm, '') : '',
          range: c.range ?? commentRange(headSource, c),
          top: topFor(c.startLine ?? c.line),
          fileLevel: c.subjectType === 'file',
        })),
      /*
       * Only threads GitHub still gives a `line` for have a place in this document.
       *
       * An outdated thread reports `line: null` and only an `originalLine`, which indexes the
       * version of the file it was written against — not the one on screen. Positioning a card
       * by that number puts it beside whatever text happens to occupy that row now, which is
       * how a comment ends up pointing at an unrelated paragraph. They go to the archive
       * instead, where they are honest about having no anchor here.
       */
      railThreads: (pr?.threads ?? [])
        .filter((t) => t.path === activePath && t.line !== null)
        .map<RailThread>((t) => ({
          thread: t,
          range: commentRange(headSource, {
            line: t.line!,
            startLine: t.startLine,
            body: t.comments[0]?.body ?? '',
            side: t.side,
          }),
          top: topFor(t.startLine ?? t.line!),
        })),
      archivedThreads: (pr?.threads ?? []).filter((t) => t.path === activePath && t.line === null),
    };
  }, [pending, pr?.threads, activePath, headSource, railTick]);

  const commentCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const t of pr?.threads ?? []) {
      if (t.isResolved) continue;
      counts.set(t.path, (counts.get(t.path) ?? 0) + 1);
    }
    for (const c of pending) counts.set(c.path, (counts.get(c.path) ?? 0) + 1);
    return counts;
  }, [pr?.threads, pending]);

  if (error) {
    return (
      <div className={`review ${showTree ? "" : "no-tree"} ${showRail ? "" : "no-rail"}`}>
        <div className="banner warn">{error}</div>
        <button className="btn" onClick={onBack}>
          Back
        </button>
      </div>
    );
  }
  if (!pr) {
    return (
      <Loading
        line={branchReview ? `Opening ${owner}/${repo}@${branch}…` : `Opening ${owner}/${repo} #${number}…`}
        slowLine="Fetching every changed file and its previous version."
      />
    );
  }

  /*
   * The registry decides, and its answer is used.
   *
   * This used to call resolve() and then throw the result away for anything that was not
   * .md/.mdx, hard-coding those to the source diff — which meant a contributed viewer could
   * never render, no matter what it claimed. The whole plugin system was inert.
   *
   * Non-Markdown files still land on the source diff, but because it claims `**​/*` at rank
   * 9000 and nothing beats it, not because of a special case here. A contributed viewer with a
   * lower rank now wins, which is what `docs/writing-a-viewer.md` promises.
   */
  const sourceDiff = registry.get('marky-mcmarkface.source-diff')?.plugin.component as
    | React.ComponentType<Record<string, unknown>>
    | undefined;
  const resolved = file ? registry.resolve(file.path) : undefined;
  // 'source' is an explicit request for the raw diff, so it overrides resolution.
  const Active =
    mode === 'source'
      ? sourceDiff
      : ((resolved?.plugin.component as React.ComponentType<Record<string, unknown>> | undefined) ?? sourceDiff);

  return (
    <div className="review">
      <header className="review-head">
        <button className="btn link" onClick={onBack}>
          ← Dashboard
        </button>
        <div className="review-title">
          <strong>{pr.title}</strong>
          <span className="muted small">
            {pr.owner}/{pr.repo} {branchReview ? 'branch' : `#${pr.number}`} · {pr.headRef} → {pr.baseRef}
          </span>
        </div>
        <div className="modes">
          {(['rich', 'final', 'source'] as Mode[]).map((m) => (
            <button key={m} className={`btn small ${mode === m ? 'on' : ''}`} onClick={() => setMode(m)}>
              {m === 'rich' ? 'Rich diff' : m === 'final' ? 'Final' : 'Source'}
            </button>
          ))}
        </div>
        <a className="btn small" href={pr.url} target="_blank" rel="noreferrer">
          GitHub
        </a>
      </header>

      {pr.warnings.map((w) => (
        <div className="banner warn" key={w}>
          {w}
        </div>
      ))}
      {referenceDisplay && referenceFile && (
        <div className="banner note">
          <span>
            Showing <strong>{referenceFile.path}</strong> from the latest <strong>{referenceFile.ref}</strong>{' '}
            because it is not changed in this {branchReview ? 'branch comparison' : 'pull request'}. This reference view is read-only.
          </span>
        </div>
      )}
      {navigationError && <div className="banner warn">{navigationError.message}</div>}
      {draftNotice && (
        <div className="banner note">
          {draftNotice}
          <button className="btn link small" onClick={() => setDraftNotice(null)}>
            Dismiss
          </button>
        </div>
      )}
      {submitted && (
        <div className="banner ok">
          {branchReview ? 'Pull request created.' : 'Review submitted.'}{' '}
          <a href={submitted} target="_blank" rel="noreferrer">View on GitHub</a>
          {createdNumber !== null && (
            <button className="btn link small" onClick={() => onPullRequestCreated(createdNumber)}>
              Open in Marky McMarkface
            </button>
          )}
        </div>
      )}

      <div className="review-body">
        <aside className="pane tree-pane">
          <FileTree
            pr={pr}
            active={activePath}
            counts={commentCounts}
            viewed={viewed}
            onSelect={(path) => openPath(path)}
            onToggleViewed={(path) =>
              setViewed((prev) => {
                const next = new Set(prev);
                if (next.has(path)) next.delete(path);
                else next.add(path);
                return next;
              })
            }
          />
        </aside>

        {/*
          The document and its margin are one unit: a single scroll container, centred together.
          Wide screens then push the rail *closer* to the prose rather than stranding it at the
          window edge, and cards cannot drift out of step with the text because there is only one
          thing scrolling.
        */}
        <div className="reading-area" data-marky-mcmarkface-scroll="">
          <main className="doc-pane">
            {file && !file.skipped && Active && (
              <div className="document-search-tools">
                {searchOpen ? (
                  <div className="document-search" role="search">
                    <input
                      ref={searchInputRef}
                      aria-label="Search this document"
                      placeholder="Search this document"
                      value={searchQuery}
                      onChange={(event) => setSearchQuery(event.target.value)}
                    />
                    <span className="document-search-count" aria-live="polite">
                      {!searchQuery ? 'Type to search' : searchCount ? `${searchIndex + 1} of ${searchCount}` : 'No results'}
                    </span>
                    <button
                      className="btn tiny document-search-step"
                      type="button"
                      aria-label="Previous result"
                      title="Previous result (Shift+Enter)"
                      disabled={!searchCount}
                      onClick={() => stepSearch(-1)}
                    >
                      ↑
                    </button>
                    <button
                      className="btn tiny document-search-step"
                      type="button"
                      aria-label="Next result"
                      title="Next result (Enter)"
                      disabled={!searchCount}
                      onClick={() => stepSearch(1)}
                    >
                      ↓
                    </button>
                    <button
                      className="btn tiny document-search-close"
                      type="button"
                      aria-label="Close search"
                      title="Close search (Escape)"
                      onClick={closeSearch}
                    >
                      ×
                    </button>
                  </div>
                ) : (
                  <button
                    className="btn small document-search-open"
                    type="button"
                    title="Search this document (Command+F)"
                    onClick={openSearch}
                  >
                    Search <kbd>⌘F</kbd>
                  </button>
                )}
              </div>
            )}
            <div className="document-viewer" ref={documentRootRef}>
              {referenceLoading !== null && referenceLoading === activePath ? (
                <Loading variant="inline" line={`Opening ${activePath} from the latest default branch…`} />
              ) : !file ? (
                <p className="muted">Select a file.</p>
              ) : file.skipped ? (
                <p className="muted">{file.skipped}</p>
              ) : Active ? (
                <Suspense fallback={<Loading variant="inline" line="Preparing the viewer…" />}>
                  <Active
                    key={`${file.path}:${mode}`}
                    file={{ path: file.path, base: file.base, head: file.head, hunks: file.patch.hunks }}
                    annotations={[]}
                    host={host}
                    registerAnchoring={registerAnchoring}
                    mode={mode === 'final' ? 'final' : 'rich'}
                  />
                </Suspense>
              ) : (
                <p className="muted">No viewer claims this file.</p>
              )}
            </div>
          </main>

          <aside className="rail-pane">
            <CommentRail
              archived={archivedThreads}
              draft={
                draft
                  ? {
                      quote: draft.quote,
                      startLine: draft.startLine,
                      line: draft.line,
                      commentable: draft.commentable,
                      body: draftBody,
                      kind: draftKind,
                      suggestion: draftSuggestion,
                      original: draft.suggestion,
                      top: topForLine(draft.startLine),
                      onChange: setDraftBody,
                      onKindChange: setDraftKind,
                      onSuggestionChange: setDraftSuggestion,
                      onSubmit: addComment,
                      onCancel: () => setDraft(null),
                    }
                  : null
              }
              pending={railPending}
              threads={railThreads}
              onRemove={(key) => setPending((prev) => prev.filter((c) => c.id !== key))}
              onReply={async (commentId, body) => {
                if (number === null) return;
                await api.reply(owner, repo, number, commentId, body);
                setPr(await api.pr(owner, repo, number));
              }}
              onResolve={async (threadId, isResolved) => {
                if (number === null) return;
                await api.resolveThread(threadId, isResolved);
                setPr(await api.pr(owner, repo, number));
              }}
              onFocus={(range) => {
                const impl = anchoringRef.current;
                if (!impl || !range) return;
                const anchored = impl.anchor(range);
                if (anchored && 'startContainer' in anchored) {
                  const selection = impl.contentContainer().ownerDocument.getSelection();
                  selection?.removeAllRanges();
                  selection?.addRange(anchored);
                }
                impl.scrollTo(range);
              }}
            />
          </aside>
        </div>
      </div>

      <footer className="review-foot">
        {branchReview && (
          <input
            placeholder="Pull request title"
            aria-label="Pull request title"
            value={pullRequestTitle}
            onChange={(e) => setPullRequestTitle(e.target.value)}
          />
        )}
        <input
          placeholder={branchReview ? 'Pull request description (optional)' : 'Review summary (optional)'}
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
        />
        {/*
          Say plainly that nothing has been sent.

          The buffered model is GitHub's own — one review, one notification to the author,
          rather than a drip of separate emails as you read — but it is invisible unless we
          say so, and "pending" alone does not tell anyone whether the author can already see
          their comments.
        */}
        {pending.length > 0 && (
          <div className="unsent">
            <strong>
              {pending.length} comment{pending.length === 1 ? '' : 's'} · not sent yet
            </strong>
            <span className="muted tiny">
              Kept on this Mac. Goes to GitHub as one review when you {branchReview ? 'create the pull request' : 'submit'}.
            </span>
          </div>
        )}
        {branchReview ? (
          <button
            className="btn primary"
            disabled={submitting || createdNumber !== null || !pullRequestTitle.trim()}
            onClick={() => void submit('COMMENT')}
          >
            {submitting ? 'Creating…' : createdNumber !== null ? 'Pull request created' : 'Create pull request'}
          </button>
        ) : (
          <>
            <button className="btn" disabled={submitting || (!summary.trim() && pending.length === 0)} onClick={() => void submit('COMMENT')}>
              Comment
            </button>
            <button
              className="btn"
              disabled={submitting || pr.viewerIsAuthor}
              title={pr.viewerIsAuthor ? 'GitHub does not allow approving your own pull request' : ''}
              onClick={() => void submit('APPROVE')}
            >
              Approve
            </button>
            <button
              className="btn danger"
              disabled={submitting || pr.viewerIsAuthor}
              title={pr.viewerIsAuthor ? 'GitHub does not allow requesting changes on your own pull request' : ''}
              onClick={() => void submit('REQUEST_CHANGES')}
            >
              Request changes
            </button>
          </>
        )}
        {submitError && <span className="error small">{submitError}</span>}
      </footer>
    </div>
  );
}

function defaultPullRequestTitle(branch: string): string {
  const words = branch.split('/').pop()!.replace(/[-_]+/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : branch;
}

/** Offset of the first character of a 1-based line. */
function lineOffset(text: string, line: number): number {
  let offset = 0;
  for (let l = 1; l < line; l++) {
    const next = text.indexOf('\n', offset);
    if (next === -1) return text.length;
    offset = next + 1;
  }
  return offset;
}

const SEARCH_HIGHLIGHT = 'marky-document-search';
const CURRENT_SEARCH_HIGHLIGHT = 'marky-document-search-current';
const fallbackSearchSelections = new WeakSet<Document>();

function paintSearchResults(doc: Document, ranges: Range[], current: number): void {
  const view = doc.defaultView;
  if (!view) return;
  const registry = view.CSS.highlights;
  if (typeof view.Highlight !== 'undefined' && registry) {
    registry.delete(SEARCH_HIGHLIGHT);
    registry.delete(CURRENT_SEARCH_HIGHLIGHT);
    if (!ranges.length) return;
    registry.set(SEARCH_HIGHLIGHT, new view.Highlight(...ranges));
    if (current >= 0 && ranges[current]) {
      registry.set(CURRENT_SEARCH_HIGHLIGHT, new view.Highlight(ranges[current]));
    }
    return;
  }

  // Older embedded Chromium builds do not expose the CSS Custom Highlight API. The active
  // browser selection still gives an honest, visible current result while count/navigation work
  // exactly the same; current desktop releases take the richer all-results path above.
  const selection = doc.getSelection();
  selection?.removeAllRanges();
  if (current >= 0 && ranges[current]) selection?.addRange(ranges[current].cloneRange());
  fallbackSearchSelections.add(doc);
}

function clearSearchResults(doc: Document): void {
  const registry = doc.defaultView?.CSS.highlights;
  registry?.delete(SEARCH_HIGHLIGHT);
  registry?.delete(CURRENT_SEARCH_HIGHLIGHT);
  if (fallbackSearchSelections.has(doc)) {
    doc.getSelection()?.removeAllRanges();
    fallbackSearchSelections.delete(doc);
  }
}

function scrollSearchResultIntoView(range: Range, root: HTMLElement | null): void {
  if (!root) return;
  const scroller = root.closest<HTMLElement>('[data-marky-mcmarkface-scroll]');
  if (!scroller) {
    range.startContainer.parentElement?.scrollIntoView({ block: 'center' });
    return;
  }
  const rect = range.getBoundingClientRect();
  const box = scroller.getBoundingClientRect();
  const target = scroller.scrollTop + rect.top - box.top - box.height / 2 + rect.height / 2;
  scroller.scrollTo({ top: Math.max(0, target), behavior: 'auto' });
}
