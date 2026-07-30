/**
 * Phase 0 gate.
 *
 * The whole product rests on one claim: a reader drag-selects rendered prose, we turn that into
 * a GitHub review comment on the right source lines, and on reload we turn it back into the same
 * highlight. This measures that claim against real repositories before a line of UI exists.
 *
 * It is graded in **source lines**, not characters, because lines are what GitHub's review API
 * actually accepts (`line` / `start_line`). Character-level comparison of rendered text against
 * source text is meaningless here: any selection crossing a backtick, a list marker, a link
 * destination or a paragraph break renders differently from its source by definition.
 *
 * Ground truth is built independently of describe(): for every text node touched by the
 * selection we take its stamp, verify the stamp is honest by checking that the source slice it
 * claims equals the text actually rendered, and only then use it. describe() is then graded
 * against that, so it cannot mark its own homework.
 *
 * Gate: correct >= 95% and round-trip >= 95%.
 *
 *   pnpm spike:anchoring [--repos a/b,c/d] [--files 60] [--samples 25]
 */
import { JSDOM } from 'jsdom';
import { offsetToLine } from '@pilcrow/viewer-api';
import { parseMarkdown, normaliseSource } from '../src/parse.js';
import { renderToHtml } from '../src/render.js';
import { describeRange, anchorRange, __internals } from '../src/anchoring.js';
import { fetchCorpus, loadFixtures } from './corpus.js';

const { closestStamp, precedingTextLength } = __internals;
const DEFAULT_REPOS = ['camunda/product-strategy', 'camunda/camunda-docs'];

function arg(name: string, fallback: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  const idx = process.argv.indexOf(`--${name}`);
  return idx !== -1 && process.argv[idx + 1] ? process.argv[idx + 1]! : fallback;
}

/** Deterministic PRNG so a failing run is reproducible from its seed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Verdict = 'exact' | 'wide' | 'block-only' | 'failed';

interface Sample {
  verdict: Verdict;
  roundTripped: boolean;
  /** Extra source lines the anchor covers beyond the lines the selection truly occupies. */
  extraLines: number;
  file: string;
  selected: string;
  recovered: string;
  detail: string;
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

function collectTextNodes(dom: JSDOM, root: Element): Text[] {
  const out: Text[] = [];
  const walker = dom.window.document.createTreeWalker(root, dom.window.NodeFilter.SHOW_TEXT);
  let n: Node | null;
  while ((n = walker.nextNode())) {
    const t = n as Text;
    if (t.data.trim().length > 0) out.push(t);
  }
  return out;
}

function intersects(range: Range, t: Text): boolean {
  try {
    return !(range.comparePoint(t, t.data.length) < 0 || range.comparePoint(t, 0) > 0);
  } catch {
    return false;
  }
}

/**
 * The true source span of a selection, derived without asking describe().
 *
 * Only stamps that survive verification contribute: `source.slice(start, end)` must equal the
 * text the browser actually rendered for that element. A stamp that fails this check is a
 * renderer bug, and letting it into the ground truth would hide exactly the defect we are
 * hunting. Returns null when no verified stamp covers the selection — those samples are
 * reported as `block-only` rather than silently passing.
 */
function groundTruth(root: Element, range: Range, source: string, texts: Text[]): { start: number; end: number } | null {
  let lo = Infinity;
  let hi = -Infinity;

  for (const t of texts) {
    if (!intersects(range, t)) continue;
    const stamp = closestStamp(t, root);
    if (!stamp || !stamp.exact) continue;
    if (source.slice(stamp.start, stamp.end) !== stamp.el.textContent) continue;

    const from = t === range.startContainer ? range.startOffset : 0;
    const to = t === range.endContainer ? range.endOffset : t.data.length;
    if (to <= from) continue;

    const pre = precedingTextLength(stamp.el, t, 0);
    if (pre === null) continue;

    lo = Math.min(lo, stamp.start + pre + from);
    hi = Math.max(hi, stamp.start + pre + to);
  }

  return hi > lo ? { start: lo, end: hi } : null;
}

/**
 * Fault injection. Shifts every stamp by N characters so a run can prove the gate has teeth —
 * a harness that cannot fail is not measuring anything. Used by `--corrupt=N`.
 */
function corruptStamps(html: string, shift: number): string {
  return html.replace(/data-pilcrow-pos="(\d+):(\d+)"/g, (_m, s: string, e: string) =>
    `data-pilcrow-pos="${Number(s) + shift}:${Number(e) + shift}"`,
  );
}

function sampleFile(id: string, raw: string, samples: number, rand: () => number, corrupt: number): Sample[] {
  const source = normaliseSource(raw);
  const tree = parseMarkdown(source);
  const html = corrupt ? corruptStamps(renderToHtml(source, tree), corrupt) : renderToHtml(source, tree);

  const dom = new JSDOM(`<!doctype html><body><div id="root">${html}</div></body>`);
  const root = dom.window.document.getElementById('root')!;
  const texts = collectTextNodes(dom, root);
  if (texts.length === 0) return [];

  const results: Sample[] = [];

  for (let i = 0; i < samples; i++) {
    const range = dom.window.document.createRange();
    const spanMultiple = rand() < 0.3 && texts.length > 2;

    const aIdx = Math.floor(rand() * texts.length);
    const a = texts[aIdx]!;
    const aStart = Math.floor(rand() * Math.max(1, a.data.length - 1));

    if (spanMultiple) {
      const bIdx = Math.min(texts.length - 1, aIdx + 1 + Math.floor(rand() * 3));
      const b = texts[bIdx]!;
      const bEnd = 1 + Math.floor(rand() * b.data.length);
      range.setStart(a, aStart);
      try {
        range.setEnd(b, bEnd);
      } catch {
        continue;
      }
    } else {
      const len = 1 + Math.floor(rand() * Math.max(1, a.data.length - aStart - 1));
      range.setStart(a, aStart);
      range.setEnd(a, Math.min(a.data.length, aStart + len));
    }

    const selected = range.toString();
    if (norm(selected).length === 0) continue;

    const described = describeRange(root as unknown as HTMLElement, range, 'RIGHT');
    const push = (verdict: Verdict, extraLines: number, detail: string, roundTripped = false) =>
      results.push({
        verdict,
        roundTripped,
        extraLines,
        file: id,
        selected,
        recovered: described ? source.slice(described.start, described.end) : '',
        detail,
      });

    if (!described) {
      push('failed', Infinity, 'describe() returned null');
      continue;
    }

    // Round-trip is graded on rendered text, which is immune to source-syntax artefacts.
    const back = anchorRange(root as unknown as HTMLElement, described);
    const backText = back ? norm(back.toString()) : '';
    const roundTripped = back !== null && backText.includes(norm(selected));

    const truth = groundTruth(root, range, source, texts);
    if (!truth) {
      push('block-only', 0, 'no verified stamp covers this selection', roundTripped);
      continue;
    }

    const trueFrom = offsetToLine(source, truth.start).line;
    const trueTo = offsetToLine(source, truth.end).line;
    const gotFrom = offsetToLine(source, described.start).line;
    const gotTo = offsetToLine(source, described.end).line;

    if (gotFrom > trueFrom || gotTo < trueTo) {
      push('failed', Infinity, `lines ${gotFrom}-${gotTo} do not cover true ${trueFrom}-${trueTo}`, roundTripped);
      continue;
    }

    const extra = gotTo - gotFrom - (trueTo - trueFrom);
    push(extra <= 1 ? 'exact' : 'wide', extra, `lines ${gotFrom}-${gotTo} vs true ${trueFrom}-${trueTo}`, roundTripped);
  }

  return results;
}

async function main() {
  const repos = arg('repos', DEFAULT_REPOS.join(',')).split(',').filter(Boolean);
  const files = Number(arg('files', '60'));
  const samples = Number(arg('samples', '25'));
  const seed = Number(arg('seed', '20260730'));
  const corrupt = Number(arg('corrupt', '0'));

  console.log(`\npilcrow Phase 0 — anchoring gate`);
  console.log(`repos=${repos.join(', ')} files<=${files}/repo samples=${samples}/file seed=${seed}`);
  if (corrupt) console.log(`FAULT INJECTION: stamps shifted by ${corrupt} chars — this run MUST fail`);
  console.log('');

  const offline = process.argv.includes('--offline');
  const corpus = offline ? await loadFixtures() : await fetchCorpus(repos, files);
  console.log(`\ncorpus: ${corpus.length} markdown files${offline ? ' (committed fixtures)' : ''}\n`);

  const rand = mulberry32(seed);
  const all: Sample[] = [];
  let parseFailures = 0;

  for (const { id, source } of corpus) {
    try {
      all.push(...sampleFile(id, source, samples, rand, corrupt));
    } catch (err) {
      parseFailures++;
      console.warn(`  ! ${id}: ${(err as Error).message}`);
    }
  }

  const total = all.length;
  const count = (v: Verdict) => all.filter((s) => s.verdict === v).length;
  const exact = count('exact');
  const wide = count('wide');
  const blockOnly = count('block-only');
  const failed = count('failed');
  const roundTripped = all.filter((s) => s.roundTripped).length;
  const pct = (n: number) => `${((n / total) * 100).toFixed(1)}%`;

  const extras = all.filter((s) => Number.isFinite(s.extraLines)).map((s) => s.extraLines).sort((a, b) => a - b);
  const q = (p: number) => extras[Math.min(extras.length - 1, Math.floor(extras.length * p))] ?? 0;

  console.log(`samples ${total}`);
  console.log(`  exact       (<=1 extra line)  ${exact} (${pct(exact)})`);
  console.log(`  wide        (>1 extra line)   ${wide} (${pct(wide)})`);
  console.log(`  block-only  (no exact stamp)  ${blockOnly} (${pct(blockOnly)})`);
  console.log(`  failed      (wrong lines)     ${failed} (${pct(failed)})`);
  console.log(`  round-tripped                 ${roundTripped} (${pct(roundTripped)})`);
  console.log(`  extra lines p50/p90/p99       ${q(0.5)} / ${q(0.9)} / ${q(0.99)}`);
  if (parseFailures) console.log(`  parse errors                  ${parseFailures} files`);

  const correct = (exact + wide + blockOnly) / total;
  const rt = roundTripped / total;
  // Without this third condition the gate has a hole: if every stamp were wrong, every stamp
  // would fail verification, every sample would fall to `block-only`, and `correct` would read
  // 100%. Round-trip cannot catch it either, since describe() and anchor() stay mutually
  // consistent under a uniform offset error. Requiring most samples to be backed by a *verified*
  // stamp is what actually detects a broken renderer.
  const verified = (exact + wide) / total;

  if (failed > 0) {
    console.log(`\nfailures (anchor does not cover the selection):`);
    for (const s of all.filter((x) => x.verdict === 'failed').slice(0, 8)) {
      console.log(`  ${s.file}  — ${s.detail}`);
      console.log(`    selected:  ${JSON.stringify(s.selected.slice(0, 80))}`);
      console.log(`    recovered: ${JSON.stringify(s.recovered.slice(0, 80))}`);
    }
  }

  const widest = all.filter((s) => s.verdict === 'wide').sort((a, b) => b.extraLines - a.extraLines).slice(0, 5);
  if (widest.length) {
    console.log(`\nwidest anchors:`);
    for (const s of widest) {
      console.log(`  +${s.extraLines} lines  ${s.file}  (${s.detail})`);
      console.log(`    selected: ${JSON.stringify(s.selected.slice(0, 70))}`);
    }
  }

  const pass = correct >= 0.95 && rt >= 0.95 && verified >= 0.9;
  console.log(
    `\nGATE ${pass ? 'PASS' : 'FAIL'} — correct ${(correct * 100).toFixed(1)}% (need 95%), ` +
      `round-trip ${(rt * 100).toFixed(1)}% (need 95%), ` +
      `stamp-verified ${(verified * 100).toFixed(1)}% (need 90%)\n`,
  );
  process.exit(pass ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
