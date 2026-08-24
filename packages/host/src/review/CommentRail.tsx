import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { SourceRange } from '@marky-mcmarkface/viewer-api';
import type { PrDetail } from '../api.js';
import { MentionTextarea } from './MentionTextarea.js';

export interface RailPending {
  key: string;
  path: string;
  startLine: number;
  line: number;
  body: string;
  suggestion?: string;
  quote: string;
  range: SourceRange | null;
  top: number;
  /** True when this is attached to the file rather than a line. */
  fileLevel?: boolean;
}

export interface RailThread {
  thread: PrDetail['threads'][number];
  range: SourceRange | null;
  top: number;
}

/** The comment being written. Lives in the rail beside its passage, like Google Docs. */
export interface RailDraft {
  quote: string;
  startLine: number;
  line: number;
  commentable: boolean;
  body: string;
  kind: 'comment' | 'suggestion';
  suggestion: string;
  original: string;
  top: number;
  onChange: (body: string) => void;
  onKindChange: (kind: 'comment' | 'suggestion') => void;
  onSuggestionChange: (suggestion: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}

/**
 * Comment cards pinned beside the prose they refer to.
 *
 * Cards are laid out top-down with collision resolution rather than absolutely at their anchor's
 * exact y — two comments on adjacent lines would otherwise stack on top of each other. This is
 * the same compromise Google Docs makes.
 */
export function CommentRail({
  draft,
  pending,
  threads,
  archived = [],
  onRemove,
  onReply,
  onResolve,
  onFocus,
}: {
  draft: RailDraft | null;
  pending: RailPending[];
  threads: RailThread[];
  /** Threads GitHub gives no current line for — outdated against this version of the file. */
  archived?: PrDetail['threads'];
  onRemove: (key: string) => void;
  onReply: (commentId: number, body: string) => Promise<void>;
  onResolve: (threadId: string, resolved: boolean) => Promise<void>;
  onFocus: (range: SourceRange | null) => void;
}) {
  const entries = useMemo(
    () =>
      [
        // The draft sorts in by position like everything else, so it appears beside the passage
        // being commented on rather than floating somewhere else on screen.
        ...(draft ? [{ key: 'draft', kind: 'draft' as const, top: draft.top, data: draft }] : []),
        ...pending.map((p) => ({ key: p.key, kind: 'pending' as const, top: p.top, data: p })),
        ...threads.map((t) => ({ key: t.thread.id, kind: 'thread' as const, top: t.top, data: t })),
      ].sort((a, b) => a.top - b.top),
    [draft, pending, threads],
  );

  const { refFor, tops } = useStackLayout(entries);

  if (entries.length === 0 && archived.length === 0) {
    return (
      <div className="rail">
        <p className="muted small rail-empty">
          Select any passage in the document to comment on it.
        </p>
      </div>
    );
  }

  return (
    <div className="rail">
      <ArchivedThreads threads={archived} />
      {entries.map((item) => {
        // Fall back to the anchor position on the very first paint, before measurement.
        const top = tops[item.key] ?? item.top;
        if (item.kind === 'draft') {
          return <DraftCard key={item.key} innerRef={refFor(item.key)} card={item.data} top={top} />;
        }
        if (item.kind === 'pending') {
          return (
            <PendingCard
              key={item.key}
              innerRef={refFor(item.key)}
              card={item.data}
              top={top}
              onRemove={onRemove}
              onFocus={onFocus}
            />
          );
        }
        return (
          <ThreadCard
            key={item.key}
            innerRef={refFor(item.key)}
            card={item.data}
            top={top}
            onReply={onReply}
            onResolve={onResolve}
            onFocus={onFocus}
          />
        );
      })}
    </div>
  );
}

/**
 * Threads with no line in this version of the file.
 *
 * GitHub reports `line: null` once a comment is outdated, leaving only an `originalLine` that
 * indexes the file as it was when the comment was written. Placing a card by that number puts
 * it beside whatever text occupies that row *now* — which is how a comment ends up pointing at
 * an unrelated paragraph. They belong in a list, not on a line, and they stay collapsed because
 * they are history rather than something waiting on the reader.
 */
function ArchivedThreads({ threads }: { threads: PrDetail['threads'] }) {
  const [open, setOpen] = useState(false);
  if (threads.length === 0) return null;

  return (
    <section className="rail-archive">
      <button className="btn link tiny" onClick={() => setOpen(!open)}>
        {open ? 'Hide' : 'Show'} {threads.length} outdated comment{threads.length === 1 ? '' : 's'}
      </button>
      {open && (
        <>
          <p className="muted tiny">These were written against an earlier version of this file.</p>
          {threads.map((t) => (
            <article className="card archived" key={t.id}>
              <header>
                <strong>{t.comments[0]?.author}</strong>
                {t.isResolved && <span className="tag">resolved</span>}
                <a className="btn link tiny" href={t.comments[0]?.url} target="_blank" rel="noreferrer noopener">
                  open
                </a>
              </header>
              <p>{t.comments[0]?.body}</p>
            </article>
          ))}
        </>
      )}
    </section>
  );
}

type CardRef = (el: HTMLElement | null) => void;

function DraftCard({ card, top, innerRef }: { card: RailDraft; top: number; innerRef: CardRef }) {
  const where = card.startLine === card.line ? `line ${card.line}` : `lines ${card.startLine}–${card.line}`;
  const inputRef = useRef<HTMLTextAreaElement>(null);

  /*
   * Put the cursor in the box on every new selection, so highlighting a passage and typing is
   * one motion.
   *
   * `autoFocus` is not enough: it only fires on mount, and this card keeps a stable key, so
   * selecting a second passage while the draft is still open updates the props without
   * remounting — leaving the cursor wherever it was. Keying the effect on the anchor covers
   * both the first selection and every re-selection after it.
   */
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    el.setSelectionRange(el.value.length, el.value.length);
  }, [card.startLine, card.line, card.quote]);

  return (
    <article ref={innerRef} className="card draft" style={{ top }}>
      <blockquote>{card.quote}</blockquote>

      {/*
        An unchanged passage is not a dead end. GitHub will not take a comment on a line outside
        the diff, but it will take one attached to the file — so offer that rather than telling
        the reader their thought cannot be recorded. Reviewing prose means often wanting to say
        something about a paragraph nobody edited.
      */}
      {!card.commentable && (
        <p className="muted small note">
          {card.startLine === card.line ? `Line ${card.line} is` : `Lines ${card.startLine}–${card.line} are`}{' '}
          unchanged, so GitHub cannot pin a comment there. This will be posted on the file instead.
        </p>
      )}

      {card.commentable && (
        <div className="draft-kind" role="group" aria-label="Feedback type">
          <button
            type="button"
            className={`btn tiny ${card.kind === 'comment' ? 'on' : ''}`}
            aria-pressed={card.kind === 'comment'}
            onClick={() => card.onKindChange('comment')}
          >
            Comment
          </button>
          <button
            type="button"
            className={`btn tiny ${card.kind === 'suggestion' ? 'on' : ''}`}
            aria-pressed={card.kind === 'suggestion'}
            onClick={() => card.onKindChange('suggestion')}
          >
            Suggest edit
          </button>
        </div>
      )}

      {card.kind === 'suggestion' && card.commentable && (
        <>
          <p className="muted tiny suggestion-note">
            Edit the source below. GitHub suggestions replace the complete selected line{card.startLine === card.line ? '' : 's'}.
          </p>
          <textarea
            className="suggestion-editor"
            rows={Math.min(10, Math.max(3, card.suggestion.split('\n').length + 1))}
            aria-label="Suggested replacement"
            spellCheck={false}
            value={card.suggestion}
            onChange={(event) => card.onSuggestionChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) card.onSubmit();
              if (event.key === 'Escape') card.onCancel();
            }}
          />
        </>
      )}

      <MentionTextarea
        ref={inputRef}
        rows={3}
        placeholder={
          card.kind === 'suggestion' && card.commentable
            ? 'Explain the suggestion (optional)…'
            : card.commentable
              ? `Comment on ${where}…`
              : 'Comment on this file…'
        }
        value={card.body}
        onValueChange={card.onChange}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) card.onSubmit();
          if (e.key === 'Escape') card.onCancel();
        }}
      />
      <div className="card-actions">
        <button
          className="btn primary tiny"
          disabled={
            card.kind === 'suggestion' && card.commentable
              ? card.suggestion === card.original
              : !card.body.trim()
          }
          onClick={card.onSubmit}
        >
          {card.kind === 'suggestion' && card.commentable
            ? 'Add suggestion'
            : card.commentable
              ? 'Add to review'
              : 'Comment on file'}
        </button>
        <button className="btn link tiny" onClick={card.onCancel}>
          Cancel
        </button>
      </div>
    </article>
  );
}

const CARD_GAP = 8;

/**
 * Stack cards without overlapping them.
 *
 * Each card wants to sit beside its own paragraph, but two comments on adjacent lines would
 * draw on top of each other — so a card that collides with the one above is pushed down.
 *
 * The heights have to be **measured**. This previously assumed a flat 84px per card, which is
 * roughly a collapsed one; an expanded thread with four replies and a reply box is several
 * hundred, so everything below it was positioned inside it. Expanding a thread is exactly when
 * a reader notices, which is why the ResizeObserver matters as much as the initial measurement.
 */
function useStackLayout(entries: Array<{ key: string; top: number }>) {
  const nodes = useRef(new Map<string, HTMLElement>());
  const [tops, setTops] = useState<Record<string, number>>({});

  const measure = useCallback(() => {
    let cursor = 0;
    const next: Record<string, number> = {};
    for (const entry of entries) {
      const height = nodes.current.get(entry.key)?.offsetHeight ?? 0;
      const top = Math.max(entry.top, cursor);
      next[entry.key] = top;
      cursor = top + height + CARD_GAP;
    }
    // Bail when nothing moved, or the ResizeObserver and this state would ping-pong forever.
    setTops((prev) => {
      const keys = Object.keys(next);
      const unchanged = keys.length === Object.keys(prev).length && keys.every((k) => prev[k] === next[k]);
      return unchanged ? prev : next;
    });
  }, [entries]);

  useLayoutEffect(measure, [measure]);

  useEffect(() => {
    const observer = new ResizeObserver(measure);
    for (const el of nodes.current.values()) observer.observe(el);
    return () => observer.disconnect();
  }, [measure]);

  const refFor = useCallback(
    (key: string) => (el: HTMLElement | null) => {
      if (el) nodes.current.set(key, el);
      else nodes.current.delete(key);
    },
    [],
  );

  return { refFor, tops };
}

function PendingCard({
  card,
  top,
  innerRef,
  onRemove,
  onFocus,
}: {
  card: RailPending;
  top: number;
  innerRef: CardRef;
  onRemove: (key: string) => void;
  onFocus: (range: SourceRange | null) => void;
}) {
  return (
    <article ref={innerRef} className="card pending" style={{ top }} onClick={() => onFocus(card.range)}>
      <header>
        <span className="tag">{card.suggestion === undefined ? 'pending' : 'suggestion'}</span>
        <span className="muted small">
          {card.fileLevel
            ? 'on this file'
            : card.startLine === card.line
              ? `line ${card.line}`
              : `lines ${card.startLine}–${card.line}`}
        </span>
        <button
          className="btn link tiny"
          onClick={(e) => {
            e.stopPropagation();
            onRemove(card.key);
          }}
        >
          remove
        </button>
      </header>
      <blockquote>{card.quote}</blockquote>
      {card.body && <p>{card.body}</p>}
      {card.suggestion !== undefined && <pre className="suggestion-preview">{card.suggestion || 'Delete these lines'}</pre>}
    </article>
  );
}

function ThreadCard({
  card,
  top,
  innerRef,
  onReply,
  onResolve,
  onFocus,
}: {
  card: RailThread;
  top: number;
  innerRef: CardRef;
  onReply: (commentId: number, body: string) => Promise<void>;
  onResolve: (threadId: string, resolved: boolean) => Promise<void>;
  onFocus: (range: SourceRange | null) => void;
}) {
  const { thread } = card;
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(!thread.isResolved);

  const last = thread.comments[thread.comments.length - 1];

  return (
    <article
      ref={innerRef}
      className={`card thread ${thread.isResolved ? 'resolved' : ''} ${thread.isOutdated ? 'outdated' : ''}`}
      style={{ top }}
      onClick={() => onFocus(card.range)}
    >
      <header>
        <strong>{thread.comments[0]?.author}</strong>
        {/*
          Say which line. A card is pushed off its exact anchor whenever the card above it is
          tall, so two threads on nearby paragraphs are otherwise impossible to tell apart —
          the reader has to infer the anchor from the quoted text, which is exactly the doubt
          this product exists to remove. Pending cards have always said it; threads did not.
        */}
        {thread.line !== null && <span className="muted small">line {thread.line}</span>}
        {thread.isResolved && <span className="tag">resolved</span>}
        {thread.isOutdated && <span className="tag">outdated</span>}
        <button
          className="btn link tiny"
          onClick={(e) => {
            e.stopPropagation();
            setOpen(!open);
          }}
        >
          {open ? 'hide' : `${thread.comments.length} comment${thread.comments.length === 1 ? '' : 's'}`}
        </button>
      </header>

      {open && (
        <>
          {thread.comments.map((c) => (
            <div className="comment" key={c.id}>
              <span className="muted small">{c.author}</span>
              <p>{c.body}</p>
            </div>
          ))}

          <form
            onClick={(e) => e.stopPropagation()}
            onSubmit={async (e) => {
              e.preventDefault();
              if (!last?.databaseId || !reply.trim()) return;
              setBusy(true);
              try {
                await onReply(last.databaseId, reply);
                setReply('');
              } finally {
                setBusy(false);
              }
            }}
          >
            <MentionTextarea
              rows={2}
              placeholder="Reply…"
              value={reply}
              onValueChange={setReply}
            />
            <div className="card-actions">
              <button className="btn tiny" disabled={busy || !reply.trim()}>
                Reply
              </button>
              <button
                type="button"
                className="btn link tiny"
                disabled={busy}
                onClick={() => void onResolve(thread.id, !thread.isResolved)}
              >
                {thread.isResolved ? 'Unresolve' : 'Resolve'}
              </button>
            </div>
          </form>
        </>
      )}
    </article>
  );
}
