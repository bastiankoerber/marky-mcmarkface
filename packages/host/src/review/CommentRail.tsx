import { useState } from 'react';
import type { PrDetail } from '../api.js';

export interface RailPending {
  key: string;
  path: string;
  startLine: number;
  line: number;
  body: string;
  quote: string;
  top: number;
}

export interface RailThread {
  thread: PrDetail['threads'][number];
  top: number;
}

/** The comment being written. Lives in the rail beside its passage, like Google Docs. */
export interface RailDraft {
  quote: string;
  startLine: number;
  line: number;
  commentable: boolean;
  body: string;
  top: number;
  onChange: (body: string) => void;
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
  onRemove,
  onReply,
  onResolve,
  onFocus,
}: {
  draft: RailDraft | null;
  pending: RailPending[];
  threads: RailThread[];
  onRemove: (key: string) => void;
  onReply: (commentId: number, body: string) => Promise<void>;
  onResolve: (threadId: string, resolved: boolean) => Promise<void>;
  onFocus: (line: number) => void;
}) {
  const laidOut = layout([
    // The draft sorts in by position like everything else, so it appears beside the passage
    // being commented on rather than floating somewhere else on screen.
    ...(draft ? [{ kind: 'draft' as const, top: draft.top, data: draft }] : []),
    ...pending.map((p) => ({ kind: 'pending' as const, top: p.top, data: p })),
    ...threads.map((t) => ({ kind: 'thread' as const, top: t.top, data: t })),
  ]);

  if (laidOut.length === 0) {
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
      {laidOut.map((item) =>
        item.kind === 'draft' ? (
          <DraftCard key="draft" card={item.data} top={item.top} />
        ) : item.kind === 'pending' ? (
          <PendingCard key={item.data.key} card={item.data} top={item.top} onRemove={onRemove} onFocus={onFocus} />
        ) : (
          <ThreadCard
            key={item.data.thread.id}
            card={item.data}
            top={item.top}
            onReply={onReply}
            onResolve={onResolve}
            onFocus={onFocus}
          />
        ),
      )}
    </div>
  );
}

function DraftCard({ card, top }: { card: RailDraft; top: number }) {
  const where = card.startLine === card.line ? `line ${card.line}` : `lines ${card.startLine}–${card.line}`;

  return (
    <article className="card draft" style={{ top }}>
      <blockquote>{card.quote}</blockquote>

      {card.commentable ? (
        <>
          <textarea
            autoFocus
            rows={3}
            placeholder={`Comment on ${where}…`}
            value={card.body}
            onChange={(e) => card.onChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) card.onSubmit();
              if (e.key === 'Escape') card.onCancel();
            }}
          />
          <div className="card-actions">
            <button className="btn primary tiny" disabled={!card.body.trim()} onClick={card.onSubmit}>
              Add to review
            </button>
            <button className="btn link tiny" onClick={card.onCancel}>
              Cancel
            </button>
          </div>
        </>
      ) : (
        <p className="muted small">
          GitHub only accepts comments on lines that appear in this pull request's diff, and{' '}
          {card.startLine === card.line ? `line ${card.line} is` : `lines ${card.startLine}–${card.line} are`}{' '}
          unchanged. Select a changed passage instead.
        </p>
      )}
    </article>
  );
}

const CARD_GAP = 8;
const MIN_HEIGHT = 84;

function layout<T extends { top: number }>(items: T[]): T[] {
  const sorted = [...items].sort((a, b) => a.top - b.top);
  let cursor = 0;
  return sorted.map((item) => {
    const top = Math.max(item.top, cursor);
    cursor = top + MIN_HEIGHT + CARD_GAP;
    return { ...item, top };
  });
}

function PendingCard({
  card,
  top,
  onRemove,
  onFocus,
}: {
  card: RailPending;
  top: number;
  onRemove: (key: string) => void;
  onFocus: (line: number) => void;
}) {
  return (
    <article className="card pending" style={{ top }} onClick={() => onFocus(card.startLine)}>
      <header>
        <span className="tag">pending</span>
        <span className="muted small">
          {card.startLine === card.line ? `line ${card.line}` : `lines ${card.startLine}–${card.line}`}
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
      <p>{card.body}</p>
    </article>
  );
}

function ThreadCard({
  card,
  top,
  onReply,
  onResolve,
  onFocus,
}: {
  card: RailThread;
  top: number;
  onReply: (commentId: number, body: string) => Promise<void>;
  onResolve: (threadId: string, resolved: boolean) => Promise<void>;
  onFocus: (line: number) => void;
}) {
  const { thread } = card;
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(!thread.isResolved);

  const last = thread.comments[thread.comments.length - 1];

  return (
    <article
      className={`card thread ${thread.isResolved ? 'resolved' : ''} ${thread.isOutdated ? 'outdated' : ''}`}
      style={{ top }}
      onClick={() => thread.line && onFocus(thread.line)}
    >
      <header>
        <strong>{thread.comments[0]?.author}</strong>
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
            <textarea
              rows={2}
              placeholder="Reply…"
              value={reply}
              onChange={(e) => setReply(e.target.value)}
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
