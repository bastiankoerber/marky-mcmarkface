import { useMemo, useState } from 'react';
import type { DashboardData, Prefs } from '../api.js';
import { api } from '../api.js';
import { draftCounts, draftKey } from '../review/draftStore.js';
import { parsePullRequestReference } from './pullRequestLink.js';
import { parseBranchReference } from './branchLink.js';

type Data = DashboardData & { prefs: Prefs; staleError?: string | null };

export function Dashboard({
  data,
  onOpen,
  onOpenBranch,
  onPrefs,
  onRefresh,
}: {
  data: Data;
  onOpen: (owner: string, repo: string, number: number) => void;
  onOpenBranch: (owner: string, repo: string, branch: string) => void;
  onPrefs: (prefs: Prefs) => void;
  onRefresh: () => void;
}) {
  const [filter, setFilter] = useState<string | null>(null);
  const [mdOnly, setMdOnly] = useState(true);
  // Read once per dashboard mount: you can only change the buffer from the review screen, and
  // coming back from one remounts this.
  const drafts = useMemo(draftCounts, []);

  const pinned = new Set(data.prefs.pinnedRepos);

  const apply = (prs: DashboardData['reviewRequested']) =>
    prs
      .filter((pr) => (filter ? pr.repository.nameWithOwner === filter : true))
      .filter((pr) => (mdOnly ? pr.markdown.count > 0 : true))
      .sort((a, b) => {
        const ap = pinned.has(a.repository.nameWithOwner) ? 0 : 1;
        const bp = pinned.has(b.repository.nameWithOwner) ? 0 : 1;
        return ap - bp || b.updatedAt.localeCompare(a.updatedAt);
      });

  const review = useMemo(() => apply(data.reviewRequested), [data, filter, mdOnly, data.prefs.pinnedRepos]);
  const mine = useMemo(() => apply(data.authored), [data, filter, mdOnly, data.prefs.pinnedRepos]);

  const togglePin = async (repo: string) => {
    const next = pinned.has(repo)
      ? data.prefs.pinnedRepos.filter((r) => r !== repo)
      : [...data.prefs.pinnedRepos, repo];
    onPrefs(await api.savePrefs({ pinnedRepos: next }));
  };

  return (
    <div className="dash">
      <div className="dash-intro">
        <p className="dash-lede">{summarise(review.length, review.filter((pr) => pr.markdown.count > 0).length)}</p>
        <QuickOpen onOpen={onOpen} onOpenBranch={onOpenBranch} />
      </div>

      {!data.prefs.pinCardDismissed && data.repos.length > 0 && (
        <PinCard data={data} onPrefs={onPrefs} pinned={pinned} onToggle={togglePin} />
      )}

      {data.warnings.map((w) => (
        <div className="banner warn" key={w}>
          {w}
        </div>
      ))}
      {data.staleError && <div className="banner warn">{data.staleError}</div>}

      <div className="dash-controls">
        <div className="chips">
          <button className={`chip ${filter === null ? 'on' : ''}`} onClick={() => setFilter(null)}>
            All repos
          </button>
          {/*
            Two hit targets, not one. The star used to be decoration on a chip whose only click
            action was filtering — pinning was bound to right-click, which nobody discovers and
            which became the *only* way to pin once the first-run card was dismissed.
          */}
          {data.repos.map((r) => (
            <span key={r.nameWithOwner} className={`chip-group ${filter === r.nameWithOwner ? 'on' : ''}`}>
              <button
                className="chip-pin"
                onClick={() => void togglePin(r.nameWithOwner)}
                aria-pressed={pinned.has(r.nameWithOwner)}
                title={pinned.has(r.nameWithOwner) ? `Unpin ${r.nameWithOwner}` : `Pin ${r.nameWithOwner}`}
              >
                {pinned.has(r.nameWithOwner) ? '★' : '☆'}
              </button>
              <button
                className="chip chip-filter"
                onClick={() => setFilter(filter === r.nameWithOwner ? null : r.nameWithOwner)}
                title={`Show only ${r.nameWithOwner}`}
              >
                {r.nameWithOwner.split('/')[1]} <span className="chip-count">{r.count}</span>
              </button>
            </span>
          ))}
        </div>
        <label className="toggle">
          <input type="checkbox" checked={mdOnly} onChange={(e) => setMdOnly(e.target.checked)} />
          Markdown only
        </label>
        <button className="btn small" onClick={onRefresh}>
          Refresh
        </button>
      </div>

      <div className="dash-grid">
        <Column title="Needs my review" count={review.length} empty="Nothing waiting on you.">
          {review.map((pr) => (
            <PrCard key={pr.url} pr={pr} onOpen={onOpen} drafts={drafts} />
          ))}
        </Column>

        <Column title="My open pull requests" count={mine.length} empty="You have no open pull requests.">
          {mine.map((pr) => (
            <PrCard key={pr.url} pr={pr} onOpen={onOpen} drafts={drafts} />
          ))}
        </Column>

        <Column title="Recent activity" count={data.activity.length} empty="Nothing recent.">
          {data.activity.map((item) => (
            <button
              key={item.id}
              className={`activity ${item.unread ? 'unread' : ''}`}
              onClick={() => {
                const [owner, repo] = item.repo.split('/');
                if (owner && repo && item.prNumber) onOpen(owner, repo, item.prNumber);
              }}
            >
              <span className={`reason r-${item.reason}`}>{item.reason.replace('_', ' ')}</span>
              <span className="activity-title">{item.title}</span>
              <span className="muted small">{item.repo}</span>
            </button>
          ))}
        </Column>
      </div>

      <p className="muted small rate">
        Dashboard cost {data.rateLimit.cost} point of {data.rateLimit.limit}; {data.rateLimit.remaining} left this hour.
      </p>
    </div>
  );
}

function QuickOpen({
  onOpen,
  onOpenBranch,
}: {
  onOpen: (owner: string, repo: string, number: number) => void;
  onOpenBranch: (owner: string, repo: string, branch: string) => void;
}) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);

  const open = (candidate: string): boolean => {
    const reference = parsePullRequestReference(candidate);
    if (reference) {
      setError(null);
      onOpen(reference.owner, reference.repo, reference.number);
      return true;
    }
    const branch = parseBranchReference(candidate);
    if (branch) {
      setError(null);
      onOpenBranch(branch.owner, branch.repo, branch.branch);
      return true;
    }
    setError('Paste a GitHub pull request or branch link, or enter owner/repo#123 or owner/repo@branch.');
    return false;
  };

  return (
    <form
      className="quick-open"
      onSubmit={(event) => {
        event.preventDefault();
        open(value);
      }}
    >
      <div className="quick-open-copy">
        <label htmlFor="quick-open-pr">Open a pull request or branch</label>
        <span>Branch feedback stays on this Mac until you create the PR.</span>
      </div>
      <div className="quick-open-action">
        <input
          id="quick-open-pr"
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            if (error) setError(null);
          }}
          onPaste={(event) => {
            const pasted = event.clipboardData.getData('text');
            if (!parsePullRequestReference(pasted) && !parseBranchReference(pasted)) return;
            event.preventDefault();
            setValue(pasted);
            open(pasted);
          }}
          placeholder="PR URL or owner/repo@branch"
          aria-describedby={error ? 'quick-open-error' : 'quick-open-hint'}
          aria-invalid={Boolean(error)}
          autoComplete="off"
          spellCheck={false}
        />
        <button className="btn primary" type="submit">
          Open
        </button>
      </div>
      {error ? (
        <span id="quick-open-error" className="quick-open-feedback error" role="alert">
          {error}
        </span>
      ) : (
        <span id="quick-open-hint" className="quick-open-feedback muted">
          Pasted links open immediately. You can also press Enter.
        </span>
      )}
    </form>
  );
}

function Column({
  title,
  count,
  empty,
  children,
}: {
  title: string;
  count: number;
  empty: string;
  children: React.ReactNode;
}) {
  return (
    <section className="col">
      <h2>
        {title} <span className="muted">{count}</span>
      </h2>
      {count === 0 ? <p className="muted small">{empty}</p> : children}
    </section>
  );
}

/**
 * A pull request you left unsent comments on says so here.
 *
 * Otherwise the buffer is invisible from outside the review screen, and an unsubmitted review is
 * indistinguishable from one never started — which is how a reader concludes they already gave
 * their feedback when the author has seen none of it.
 */
function PrCard({
  pr,
  onOpen,
  drafts,
}: {
  pr: DashboardData['reviewRequested'][number];
  onOpen: (owner: string, repo: string, number: number) => void;
  drafts: Record<string, number>;
}) {
  const [owner, repo] = pr.repository.nameWithOwner.split('/');
  const unsent = drafts[draftKey(owner ?? '', repo ?? '', pr.number)] ?? 0;
  const allMarkdown = pr.markdown.total > 0 && pr.markdown.count === pr.markdown.total && !pr.markdown.truncated;

  return (
    <button className="pr" onClick={() => owner && repo && onOpen(owner, repo, pr.number)}>
      <div className="pr-head">
        <span className="pr-repo">{repo}</span>
        <span className="pr-num">#{pr.number}</span>
        {pr.isDraft && <span className="tag">draft</span>}
        {unsent > 0 && (
          <span className="tag unsent-tag">
            {unsent} unsent
          </span>
        )}
        {allMarkdown ? (
          <span className="tag md">all markdown</span>
        ) : pr.markdown.count > 0 ? (
          <span className="tag md">
            {pr.markdown.count}/{pr.markdown.truncated ? `${pr.markdown.total}+` : pr.markdown.total} md
          </span>
        ) : null}
      </div>
      <div className="pr-title">{pr.title}</div>
      <div className="pr-meta muted small">
        {pr.author?.login} · <span className="add">+{pr.additions}</span>{' '}
        <span className="del">−{pr.deletions}</span> · {relative(pr.updatedAt)}
      </div>
    </button>
  );
}

function PinCard({
  data,
  onPrefs,
  pinned,
  onToggle,
}: {
  data: Data;
  onPrefs: (p: Prefs) => void;
  pinned: Set<string>;
  onToggle: (repo: string) => void;
}) {
  return (
    <div className="banner pin">
      <div>
        <strong>Pin the repos you review most?</strong>
        <p className="muted small">
          Pinned repos sort first. Nothing is ever hidden — this list came from the pull requests
          you already have, so there is no repo picker to get wrong.
        </p>
        <div className="chips">
          {data.repos.map((r) => (
            <button
              key={r.nameWithOwner}
              className={`chip ${pinned.has(r.nameWithOwner) ? 'on' : ''}`}
              onClick={() => void onToggle(r.nameWithOwner)}
            >
              {pinned.has(r.nameWithOwner) ? '★ ' : '☆ '}
              {r.nameWithOwner}
            </button>
          ))}
        </div>
      </div>
      <button className="btn link" onClick={async () => onPrefs(await api.savePrefs({ pinCardDismissed: true }))}>
        Done
      </button>
    </div>
  );
}

/**
 * A sentence, not a stat block. It is the first thing on the screen after connecting, and it
 * should answer "is there anything for me" before the eye reaches any card.
 */
function summarise(waiting: number, markdown: number): string {
  if (waiting === 0) return 'Nothing is waiting for your review.';
  const lead = waiting === 1 ? 'One pull request is waiting for your review.' : `${waiting} pull requests are waiting for your review.`;
  if (markdown === 0) return lead;
  if (markdown === waiting) return `${lead} ${waiting === 1 ? 'It touches' : 'They all touch'} Markdown.`;
  return `${lead} ${markdown} ${markdown === 1 ? 'touches' : 'touch'} Markdown.`;
}

function relative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
