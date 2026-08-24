import DOMPurify from 'dompurify';
import type { MermaidConfig } from 'mermaid';
import { sanitizeMermaidSvg } from './sanitize.js';

const DIAGRAM_SELECTOR = '[data-marky-mcmarkface-mermaid]';
const MAX_SOURCE_LENGTH = 50_000;
const MIN_SCALE = 0.05;
const MAX_SCALE = 4;
const SCALE_STEP = 1.25;

let sequence = 0;
let renderQueue: Promise<void> = Promise.resolve();

/**
 * Upgrade Mermaid code blocks after authored Markdown has crossed the sanitisation boundary.
 *
 * The original source is restored during effect cleanup, which makes theme changes and React
 * remounts deterministic. Rendering is serialised because Mermaid configuration is process-wide.
 */
export function enhanceMermaidDiagrams(root: HTMLElement, theme: 'light' | 'dark'): () => void {
  const diagrams = Array.from(root.querySelectorAll<HTMLElement>(DIAGRAM_SELECTOR)).map((element) => ({
    element,
    originalHtml: element.innerHTML,
    cleanup: () => {},
  }));
  let active = true;

  for (const diagram of diagrams) {
    const source = sourceFromDiagram(diagram.element);
    if (source === null) continue;
    void enqueue(async () => {
      if (!active || !diagram.element.isConnected) return;
      try {
        if (source.length > MAX_SOURCE_LENGTH) {
          throw new Error('diagram source exceeds the rendering limit');
        }
        const mermaid = (await import('mermaid')).default;
        mermaid.initialize(configFor(theme));
        const result = await mermaid.render(`marky-mermaid-${++sequence}`, source);
        if (!active || !diagram.element.isConnected) return;

        const viewport = root.ownerDocument.createElement('div');
        viewport.className = 'md-mermaid-viewport';
        viewport.tabIndex = 0;
        viewport.setAttribute('aria-label', 'Mermaid diagram. Scroll to explore when zoomed.');
        viewport.innerHTML = sanitizeMermaidSvg(result.svg, DOMPurify);
        const svg = viewport.querySelector('svg');
        if (!svg) throw new Error('Mermaid returned no SVG');
        svg.setAttribute('role', 'img');
        prepareMermaidLinks(svg);

        const output = root.ownerDocument.createElement('div');
        output.className = 'md-mermaid-output';
        const controls = createDiagramControls(viewport, svg);
        output.append(controls.element, viewport);

        // Removing the stamped source avoids anchoring a comment to invisible code. SVG labels
        // inherit the wrapper's block stamp, so diagram selections degrade honestly to the full
        // source block and existing comments remain visibly positioned beside the diagram.
        diagram.element.replaceChildren(output);
        diagram.element.setAttribute('data-marky-mcmarkface-mermaid-rendered', '');
        diagram.cleanup = controls.mount();
      } catch {
        if (!active || !diagram.element.isConnected) return;
        const message = root.ownerDocument.createElement('div');
        message.className = 'md-mermaid-error';
        message.setAttribute('role', 'status');
        message.textContent = 'Mermaid diagram could not be rendered. Source is shown below.';
        diagram.element.prepend(message);
      }
    });
  }

  return () => {
    active = false;
    for (const diagram of diagrams) {
      diagram.cleanup();
      if (!diagram.element.isConnected) continue;
      diagram.element.innerHTML = diagram.originalHtml;
      diagram.element.removeAttribute('data-marky-mcmarkface-mermaid-rendered');
    }
  };
}

/** Make repository-relative and ordinary web links behave like links in rendered Markdown. */
export function prepareMermaidLinks(svg: SVGElement): void {
  // Mermaid currently emits namespaced xlink:href in SVG. Querying the attribute through CSS is
  // inconsistent across HTML/SVG DOM implementations, so inspect every generated anchor.
  for (const anchor of svg.querySelectorAll('a')) {
    const href = anchor.getAttribute('href') ?? anchor.getAttribute('xlink:href');
    if (!href) continue;
    anchor.setAttribute('href', href);
    anchor.removeAttribute('xlink:href');
    anchor.setAttribute('target', '_blank');
    anchor.setAttribute('rel', 'noreferrer');
    anchor.setAttribute('role', 'link');
    anchor.setAttribute('aria-label', anchor.textContent?.trim() || href);
  }
}

interface DiagramControls {
  element: HTMLElement;
  mount: () => () => void;
}

function createDiagramControls(viewport: HTMLElement, svg: SVGElement): DiagramControls {
  const document = viewport.ownerDocument;
  const element = document.createElement('div');
  element.className = 'md-mermaid-controls';
  element.setAttribute('aria-label', 'Diagram zoom controls');

  const status = document.createElement('output');
  status.className = 'md-mermaid-scale';
  status.setAttribute('aria-live', 'polite');

  const fitButton = controlButton(document, 'Fit', 'Fit diagram to available width');
  const actualButton = controlButton(document, '1:1', 'Show diagram at its natural size');
  const outButton = controlButton(document, '−', 'Zoom out');
  const inButton = controlButton(document, '+', 'Zoom in');
  element.append(fitButton, actualButton, outButton, status, inButton);

  const naturalWidth = widthOf(svg);
  let scale = 1;
  let fitted = true;
  let frame = 0;

  const apply = (next: number, fit: boolean, centreOverride?: number) => {
    const centre = centreOverride ?? (viewport.scrollWidth
      ? (viewport.scrollLeft + viewport.clientWidth / 2) / viewport.scrollWidth
      : 0.5);
    scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, next));
    fitted = fit;
    svg.style.width = `${Math.max(1, naturalWidth * scale)}px`;
    svg.style.maxWidth = 'none';
    svg.style.height = 'auto';
    status.value = `${Math.round(scale * 100)}%`;
    fitButton.setAttribute('aria-pressed', String(fitted));
    actualButton.setAttribute('aria-pressed', String(!fitted && Math.abs(scale - 1) < 0.001));
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      viewport.scrollLeft = Math.max(0, centre * viewport.scrollWidth - viewport.clientWidth / 2);
    });
  };

  const fit = () => apply(Math.min(1, Math.max(1, viewport.clientWidth - 24) / naturalWidth), true);
  const actual = () => apply(1, false);
  const zoomOut = () => apply(scale / SCALE_STEP, false);
  const zoomIn = () => apply(scale * SCALE_STEP, false);

  return {
    element,
    mount: () => {
      fitButton.addEventListener('click', fit);
      actualButton.addEventListener('click', actual);
      outButton.addEventListener('click', zoomOut);
      inButton.addEventListener('click', zoomIn);
      const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => fitted && fit());
      observer?.observe(viewport);
      const fitScale = Math.min(1, Math.max(1, viewport.clientWidth - 24) / naturalWidth);
      // An overview below 50% stops being a diagram and becomes a row of illegible marks. Open
      // very large diagrams at readable natural size, aligned to their beginning; Fit remains a
      // one-click overview. Ordinary diagrams still start fitted to the document.
      if (fitScale < 0.5) apply(1, false, 0);
      else fit();
      return () => {
        cancelAnimationFrame(frame);
        observer?.disconnect();
        fitButton.removeEventListener('click', fit);
        actualButton.removeEventListener('click', actual);
        outButton.removeEventListener('click', zoomOut);
        inButton.removeEventListener('click', zoomIn);
      };
    },
  };
}

function controlButton(document: Document, label: string, accessibleLabel: string): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'md-mermaid-control';
  button.textContent = label;
  button.setAttribute('aria-label', accessibleLabel);
  return button;
}

function widthOf(svg: SVGElement): number {
  const viewBox = svg.getAttribute('viewBox')?.trim().split(/[\s,]+/).map(Number);
  const fromViewBox = viewBox?.length === 4 ? viewBox[2] : undefined;
  if (fromViewBox && Number.isFinite(fromViewBox) && fromViewBox > 0) return fromViewBox;
  const width = Number.parseFloat(svg.getAttribute('width') ?? '');
  return Number.isFinite(width) && width > 0 ? width : 800;
}

/** Rich diffs include deleted source in <del>; Mermaid must render only the head document. */
export function sourceFromDiagram(element: Element): string | null {
  const source = element.querySelector('pre');
  if (!source?.querySelector('code[data-lang="mermaid" i]')) return null;
  const current = source.cloneNode(true) as Element;
  for (const deletion of current.querySelectorAll('[data-marky-mcmarkface-del]')) deletion.remove();
  return current.textContent;
}

function enqueue(task: () => Promise<void>): Promise<void> {
  const next = renderQueue.then(task, task);
  renderQueue = next.catch(() => undefined);
  return next;
}

function configFor(theme: 'light' | 'dark'): MermaidConfig {
  return {
    startOnLoad: false,
    // `loose` lets Mermaid emit ordinary <a> elements. The SVG is never trusted: DOMPurify and
    // sanitizeMermaidSvg remove script, events, foreign content, unsafe URLs, and resource loads
    // before anything reaches the live document. We deliberately do not call bindFunctions.
    securityLevel: 'loose',
    suppressErrorRendering: true,
    htmlLabels: false,
    maxTextSize: MAX_SOURCE_LENGTH,
    maxEdges: 500,
    theme: theme === 'dark' ? 'dark' : 'default',
    // Diagram directives must not relax the trust boundary or inject custom presentation CSS.
    secure: [
      'secure',
      'securityLevel',
      'startOnLoad',
      'suppressErrorRendering',
      'maxTextSize',
      'maxEdges',
      'theme',
      'themeCSS',
      'themeVariables',
      'fontFamily',
      'altFontFamily',
      'htmlLabels',
    ],
  };
}
