import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { offsetToLine, quoteFor, type AnchoringImpl, type SourceRange, type ViewerHost } from '@pilcrow/viewer-api';
import { api, type PendingComment, type PrDetail, type ReviewEvent } from '../api.js';
import { createRegistry } from '../viewers/index.js';
import { FileTree } from './FileTree.jsx';
import { CommentRail, type RailPending, type RailThread } from './CommentRail.jsx';

type Mode = 'rich' | 'final' | 'source';

interface Draft {
  range: SourceRange;
  startLine: number;
  line: number;
  quote: string;
  commentable: boolean;
}

/**
 * Pending comments carry a stable id rather than being addressed by array index. The rail only
 * shows the active file's comments, so its indices are into a *filtered* list — using those to
 * splice the full buffer deletes the wrong comment as soon as two files have pending notes.
 */
type LocalComment = PendingComment & { id: string };

let commentSeq = 0;
const nextCommentId = () => `c${++commentSeq}`;

export function Review({
  owner,
  repo,
  number,
  onBack,
}: {
  owner: string;
  repo: string;
  number: number;
  onBack: () => void;
}) {
  const [pr, setPr] = useState<PrDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>('rich');
  const [viewed, setViewed] = useState<Set<string>>(new Set());

  const [draft, setDraft] = useState<Draft | null>(null);
  const [draftBody, setDraftBody] = useState('');
  const [pending, setPending] = useState<LocalComment[]>([]);
  const [summary, setSummary] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState<string | null>(null);
  const [railTick, setRailTick] = useState(0);

  const anchoringRef = useRef<AnchoringImpl | null>(null);
  const registry = useMemo(() => createRegistry(), []);

  useEffect(() => {
    let live = true;
    setPr(null);
    setError(null);
    api
      .pr(owner, repo, number)
      .then((data) => {
        if (!live) return;
        setPr(data);
        setActivePath(data.files.find((f) => /\.mdx?$/i.test(f.path))?.path ?? data.files[0]?.path ?? null);
      })
      .catch((err) => live && setError((err as Error).message));
    return () => {
      live = false;
    };
  }, [owner, repo, number]);

  const file = pr?.files.find((f) => f.path === activePath) ?? null;
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
        if (!range || !headSource) {
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
        });
        setDraftBody('');
      },
      commentableRanges: () => file?.patch.rightLines ?? [],
      requestComment: () => {},
      theme: 'light',
    }),
    [headSource, commentableAt, file],
  );

  const addComment = () => {
    if (!draft || !file || !draftBody.trim()) return;
    setPending((prev) => [
      ...prev,
      {
        id: nextCommentId(),
        path: file.path,
        side: 'RIGHT',
        line: draft.line,
        ...(draft.startLine < draft.line ? { startLine: draft.startLine } : {}),
        body: `> ${draft.quote.replace(/\n/g, '\n> ')}\n\n${draftBody.trim()}`,
      },
    ]);
    setDraft(null);
    setDraftBody('');
    window.getSelection()?.removeAllRanges();
  };

  const submit = async (event: ReviewEvent) => {
    if (!pr) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const result = await api.submitReview(owner, repo, number, {
        event,
        body: summary,
        // Strip the local id; it is a UI concern and has no meaning to GitHub.
        comments: pending.map(({ id: _id, ...comment }) => comment),
      });
      setPending([]);
      setSummary('');
      setSubmitted(result.url);
      setPr(await api.pr(owner, repo, number));
    } catch (err) {
      setSubmitError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  // Place rail cards next to the prose they refer to, by asking the viewer to anchor each one.
  const { railPending, railThreads } = useMemo(() => {
    void railTick;
    const impl = anchoringRef.current;
    const container = impl?.contentContainer();
    const base = container?.getBoundingClientRect().top ?? 0;

    const topFor = (line: number): number => {
      if (!impl || !headSource) return line * 22;
      const offset = lineOffset(headSource, line);
      const anchored = impl.anchor({ side: 'RIGHT', start: offset, end: offset + 1 });
      if (!anchored) return line * 22;
      const rect = 'getBoundingClientRect' in anchored ? anchored.getBoundingClientRect() : null;
      return rect ? rect.top - base : line * 22;
    };

    return {
      railPending: pending
        .filter((c) => c.path === activePath)
        .map<RailPending>((c) => ({
          key: c.id,
          path: c.path,
          startLine: c.startLine ?? c.line,
          line: c.line,
          body: c.body.replace(/^> .*\n\n/s, ''),
          quote: c.body.startsWith('>') ? (c.body.split('\n\n')[0] ?? '').replace(/^> /gm, '') : '',
          top: topFor(c.startLine ?? c.line),
        })),
      railThreads: (pr?.threads ?? [])
        .filter((t) => t.path === activePath)
        .map<RailThread>((t) => ({ thread: t, top: topFor(t.line ?? t.originalLine ?? 1) })),
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
      <div className="review">
        <div className="banner warn">{error}</div>
        <button className="btn" onClick={onBack}>
          Back
        </button>
      </div>
    );
  }
  if (!pr) return <div className="review loading">Loading pull request…</div>;

  const resolved = file ? registry.resolve(file.path) : undefined;
  const Viewer = resolved?.plugin.component as React.ComponentType<Record<string, unknown>> | undefined;
  const useSourceViewer = mode === 'source' || !/\.mdx?$/i.test(file?.path ?? '');
  const SourceViewer = registry.get('pilcrow.source-diff')?.plugin.component as
    | React.ComponentType<Record<string, unknown>>
    | undefined;
  const Active = useSourceViewer ? SourceViewer : Viewer;

  return (
    <div className="review">
      <header className="review-head">
        <button className="btn link" onClick={onBack}>
          ← Dashboard
        </button>
        <div className="review-title">
          <strong>{pr.title}</strong>
          <span className="muted small">
            {pr.owner}/{pr.repo} #{pr.number} · {pr.headRef} → {pr.baseRef}
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
      {submitted && (
        <div className="banner ok">
          Review submitted. <a href={submitted} target="_blank" rel="noreferrer">View on GitHub</a>
        </div>
      )}

      <div className="review-body">
        <aside className="pane tree-pane">
          <FileTree
            pr={pr}
            active={activePath}
            counts={commentCounts}
            viewed={viewed}
            onSelect={setActivePath}
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

        <main className="pane doc-pane" data-pilcrow-scroll="">
          {!file ? (
            <p className="muted">Select a file.</p>
          ) : file.skipped ? (
            <p className="muted">{file.skipped}</p>
          ) : Active ? (
            <Suspense fallback={<p className="muted">Loading viewer…</p>}>
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
        </main>

        <aside className="pane rail-pane">
          <CommentRail
            pending={railPending}
            threads={railThreads}
            onRemove={(key) => setPending((prev) => prev.filter((c) => c.id !== key))}
            onReply={async (commentId, body) => {
              await api.reply(owner, repo, number, commentId, body);
              setPr(await api.pr(owner, repo, number));
            }}
            onResolve={async (threadId, isResolved) => {
              await api.resolveThread(threadId, isResolved);
              setPr(await api.pr(owner, repo, number));
            }}
            onFocus={(line) => {
              const impl = anchoringRef.current;
              if (!impl || !headSource) return;
              impl.scrollTo({ side: 'RIGHT', start: lineOffset(headSource, line), end: lineOffset(headSource, line) + 1 });
            }}
          />
        </aside>
      </div>

      {draft && (
        <div className="composer">
          <blockquote>{draft.quote}</blockquote>
          {draft.commentable ? (
            <>
              <textarea
                autoFocus
                rows={3}
                placeholder={`Comment on ${draft.startLine === draft.line ? `line ${draft.line}` : `lines ${draft.startLine}–${draft.line}`}…`}
                value={draftBody}
                onChange={(e) => setDraftBody(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) addComment();
                  if (e.key === 'Escape') setDraft(null);
                }}
              />
              <div className="composer-actions">
                <button className="btn primary" disabled={!draftBody.trim()} onClick={addComment}>
                  Add to review
                </button>
                <button className="btn link" onClick={() => setDraft(null)}>
                  Cancel
                </button>
              </div>
            </>
          ) : (
            <p className="muted small">
              GitHub only accepts comments on lines that appear in this pull request's diff, and
              lines {draft.startLine}–{draft.line} are unchanged. Select a changed passage instead.
            </p>
          )}
        </div>
      )}

      <footer className="review-foot">
        <input
          placeholder="Review summary (optional)"
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
        />
        <span className="muted small">
          {pending.length} pending comment{pending.length === 1 ? '' : 's'}
        </span>
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
        {submitError && <span className="error small">{submitError}</span>}
      </footer>
    </div>
  );
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
