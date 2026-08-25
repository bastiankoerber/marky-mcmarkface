import DOMPurify from 'dompurify';
import type { SourceRange } from '@marky-mcmarkface/viewer-api';
import type { MermaidConfig } from 'mermaid';
import { sanitizeMermaidSvg } from './sanitize.js';

const DIAGRAM_SELECTOR = '[data-marky-mcmarkface-mermaid]';
const MAX_SOURCE_LENGTH = 50_000;
const MIN_SCALE = 0.05;
const MAX_SCALE = 4;
const SCALE_STEP = 1.25;

let sequence = 0;
let renderQueue: Promise<unknown> = Promise.resolve();

interface MermaidEnhancementOptions {
  theme: 'light' | 'dark';
  documentSource: string;
  requestSuggestion?: (selection: SourceRange, replacement: string) => boolean;
}

/**
 * Upgrade Mermaid code blocks after authored Markdown has crossed the sanitisation boundary.
 *
 * The original source is restored during effect cleanup, which makes theme changes and React
 * remounts deterministic. Rendering is serialised because Mermaid configuration is process-wide.
 */
export function enhanceMermaidDiagrams(
  root: HTMLElement,
  { theme, documentSource, requestSuggestion }: MermaidEnhancementOptions,
): () => void {
  const diagrams = Array.from(root.querySelectorAll<HTMLElement>(DIAGRAM_SELECTOR)).map((element) => ({
    element,
    originalHtml: element.innerHTML,
    cleanup: () => {},
  }));
  let active = true;

  for (const diagram of diagrams) {
    const source = sourceFromDiagram(diagram.element);
    if (source === null) continue;
    const range = sourceRangeFromDiagram(root, diagram.element);
    void (async () => {
      if (!active || !diagram.element.isConnected) return;
      try {
        const rendered = await renderMermaidSvg(source, theme);
        if (!active || !diagram.element.isConnected) return;

        const { viewport, svg } = createDiagramViewport(root.ownerDocument, rendered);

        const output = root.ownerDocument.createElement('div');
        output.className = 'md-mermaid-output';
        let editorCleanup = () => {};
        const editable = Boolean(range && requestSuggestion);
        const closeEditor = () => {
          editorCleanup();
          editorCleanup = () => {};
          if (!active || !diagram.element.isConnected) return;
          diagram.element.replaceChildren(output);
        };
        const openEditor = editable
          ? () => {
              if (!range || !requestSuggestion || !diagram.element.isConnected) return;
              const editor = createMermaidEditor({
                document: root.ownerDocument,
                source,
                theme,
                replacementFor: (nextSource) =>
                  replacementForMermaid(documentSource, range, source, nextSource),
                onCancel: closeEditor,
                onSuggest: (replacement) => {
                  const accepted = requestSuggestion(range, replacement);
                  if (accepted) closeEditor();
                  return accepted;
                },
              });
              editorCleanup();
              editorCleanup = editor.cleanup;
              diagram.element.replaceChildren(editor.element);
              editor.focus();
            }
          : undefined;
        const controls = createDiagramControls(viewport, svg, openEditor);
        output.append(controls.element, viewport);

        // Removing the stamped source avoids anchoring a comment to invisible code. SVG labels
        // inherit the wrapper's block stamp, so diagram selections degrade honestly to the full
        // source block and existing comments remain visibly positioned beside the diagram.
        diagram.element.replaceChildren(output);
        ensureMermaidNodeContrast(svg);
        diagram.element.setAttribute('data-marky-mcmarkface-mermaid-rendered', '');
        const controlsCleanup = controls.mount();
        const editCleanup = openEditor ? makeDiagramEditable(viewport, openEditor) : () => {};
        diagram.cleanup = () => {
          editorCleanup();
          editCleanup();
          controlsCleanup();
        };
      } catch {
        if (!active || !diagram.element.isConnected) return;
        const message = root.ownerDocument.createElement('div');
        message.className = 'md-mermaid-error';
        message.setAttribute('role', 'status');
        message.textContent = 'Mermaid diagram could not be rendered. Source is shown below.';
        diagram.element.prepend(message);
      }
    })();
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

function createDiagramViewport(
  document: Document,
  rendered: string,
): { viewport: HTMLElement; svg: SVGElement } {
  const viewport = document.createElement('div');
  viewport.className = 'md-mermaid-viewport';
  viewport.tabIndex = 0;
  viewport.setAttribute('aria-label', 'Mermaid diagram. Scroll to explore when zoomed.');
  viewport.innerHTML = rendered;
  const svg = viewport.querySelector('svg');
  if (!svg) throw new Error('Mermaid returned no SVG');
  svg.setAttribute('role', 'img');
  prepareMermaidLinks(svg);
  return { viewport, svg };
}

function makeDiagramEditable(viewport: HTMLElement, onEdit: () => void): () => void {
  viewport.classList.add('md-mermaid-editable');
  viewport.setAttribute('aria-label', 'Mermaid diagram. Click to edit; scroll to explore when zoomed.');
  const click = (event: MouseEvent) => {
    const target = event.target as Element | null;
    if (target?.closest?.('a')) return;
    onEdit();
  };
  const keydown = (event: KeyboardEvent) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    onEdit();
  };
  viewport.addEventListener('click', click);
  viewport.addEventListener('keydown', keydown);
  return () => {
    viewport.removeEventListener('click', click);
    viewport.removeEventListener('keydown', keydown);
  };
}

interface MermaidEditorOptions {
  document: Document;
  source: string;
  theme: 'light' | 'dark';
  replacementFor: (source: string) => string | null;
  onCancel: () => void;
  onSuggest: (replacement: string) => boolean;
}

interface MermaidEditor {
  element: HTMLElement;
  focus: () => void;
  cleanup: () => void;
}

function createMermaidEditor({
  document,
  source,
  theme,
  replacementFor,
  onCancel,
  onSuggest,
}: MermaidEditorOptions): MermaidEditor {
  const timerWindow = document.defaultView;
  if (!timerWindow) throw new Error('Mermaid editor requires a browser document');
  const element = document.createElement('section');
  element.className = 'md-mermaid-editor';
  element.setAttribute('aria-label', 'Edit Mermaid diagram');

  const header = document.createElement('header');
  header.className = 'md-mermaid-editor-header';
  const title = document.createElement('strong');
  title.textContent = 'Edit Mermaid source';
  const status = document.createElement('span');
  status.className = 'md-mermaid-editor-status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const actions = document.createElement('div');
  actions.className = 'md-mermaid-editor-actions';
  const cancelButton = editorButton(document, 'Cancel');
  const suggestButton = editorButton(document, 'Add suggestion', true);
  actions.append(cancelButton, suggestButton);
  header.append(title, status, actions);

  const body = document.createElement('div');
  body.className = 'md-mermaid-editor-body';
  const sourceField = document.createElement('label');
  sourceField.className = 'md-mermaid-editor-source';
  const sourceLabel = document.createElement('span');
  sourceLabel.textContent = 'Mermaid source';
  const textarea = document.createElement('textarea');
  textarea.className = 'md-mermaid-editor-textarea';
  textarea.setAttribute('aria-label', 'Mermaid source');
  textarea.setAttribute('spellcheck', 'false');
  textarea.value = source;
  sourceField.append(sourceLabel, textarea);
  const preview = document.createElement('div');
  preview.className = 'md-mermaid-editor-preview';
  preview.setAttribute('aria-label', 'Live Mermaid preview');
  body.append(sourceField, preview);
  element.append(header, body);

  let disposed = false;
  let valid = false;
  let previewRequest = 0;
  let previewTimer = 0;
  let previewCleanup = () => {};

  const updateSubmit = () => {
    suggestButton.disabled =
      !valid || textarea.value === source || replacementFor(textarea.value) === null;
  };

  const renderPreview = async () => {
    const request = ++previewRequest;
    const nextSource = textarea.value;
    valid = false;
    updateSubmit();
    status.textContent = 'Rendering preview…';
    try {
      const rendered = await renderMermaidSvg(nextSource, theme);
      if (disposed || request !== previewRequest || !element.isConnected) return;
      const { viewport, svg } = createDiagramViewport(document, rendered);
      const controls = createDiagramControls(viewport, svg);
      const output = document.createElement('div');
      output.className = 'md-mermaid-editor-preview-output';
      output.append(controls.element, viewport);
      previewCleanup();
      previewCleanup = controls.mount();
      preview.replaceChildren(output);
      ensureMermaidNodeContrast(svg);
      valid = true;
      status.textContent = 'Preview updated';
      updateSubmit();
    } catch {
      if (disposed || request !== previewRequest || !element.isConnected) return;
      previewCleanup();
      previewCleanup = () => {};
      const error = document.createElement('p');
      error.className = 'md-mermaid-editor-error';
      error.setAttribute('role', 'alert');
      error.textContent = 'This Mermaid source cannot be rendered yet.';
      preview.replaceChildren(error);
      status.textContent = 'Fix the Mermaid syntax to continue';
      valid = false;
      updateSubmit();
    }
  };

  const schedulePreview = () => {
    timerWindow.clearTimeout(previewTimer);
    previewTimer = timerWindow.setTimeout(() => void renderPreview(), 220);
    valid = false;
    status.textContent = 'Waiting to update preview…';
    updateSubmit();
  };
  const cancel = () => onCancel();
  const suggest = () => {
    const replacement = replacementFor(textarea.value);
    if (!valid || replacement === null || textarea.value === source) return;
    if (!onSuggest(replacement)) {
      status.textContent = 'GitHub cannot attach this whole-diagram suggestion to the current diff';
    }
  };
  const keydown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      cancel();
    }
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !suggestButton.disabled) {
      event.preventDefault();
      suggest();
    }
  };

  textarea.addEventListener('input', schedulePreview);
  textarea.addEventListener('keydown', keydown);
  cancelButton.addEventListener('click', cancel);
  suggestButton.addEventListener('click', suggest);
  void renderPreview();

  return {
    element,
    focus: () => textarea.focus({ preventScroll: true }),
    cleanup: () => {
      disposed = true;
      previewRequest++;
      timerWindow.clearTimeout(previewTimer);
      previewCleanup();
      textarea.removeEventListener('input', schedulePreview);
      textarea.removeEventListener('keydown', keydown);
      cancelButton.removeEventListener('click', cancel);
      suggestButton.removeEventListener('click', suggest);
    },
  };
}

function editorButton(document: Document, label: string, primary = false): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `md-mermaid-editor-button${primary ? ' primary' : ''}`;
  button.textContent = label;
  return button;
}

const DARK_NODE_INK = '#1f2328';
const LIGHT_NODE_INK = '#f6f8fa';
const DARK_NODE_INK_RGB: RgbColour = { red: 31, green: 35, blue: 40, alpha: 1 };
const LIGHT_NODE_INK_RGB: RgbColour = { red: 246, green: 248, blue: 250, alpha: 1 };

/**
 * Keep authored node fills legible when they cross Mermaid themes.
 *
 * Mermaid's dark theme supplies pale label text globally. A diagram can then apply a light
 * `classDef ... fill:#...` without a matching `color`, producing pale text on a pale node. The
 * authored fill is emitted as an inline style, so limit correction to that case and leave the
 * theme's own node palette alone. An authored label color remains authoritative.
 */
export function ensureMermaidNodeContrast(svg: SVGElement): void {
  const view = svg.ownerDocument.defaultView;
  if (!view) return;

  for (const node of svg.querySelectorAll<SVGGElement>('g.node')) {
    const label = node.querySelector<SVGGElement>('g.label');
    if (!label || hasAuthoredLabelColour(label)) continue;

    const shape = Array.from(
      node.querySelectorAll<SVGGraphicsElement>('.label-container, rect, circle, ellipse, polygon, path'),
    ).find(hasAuthoredFill);
    if (!shape) continue;

    const fill = parseComputedRgb(
      view.getComputedStyle(shape).fill || shape.style.getPropertyValue('fill'),
    );
    if (!fill || fill.alpha < 0.95) continue;
    const fillLuminance = relativeLuminance(fill);
    const darkContrast = contrastRatio(fillLuminance, relativeLuminance(DARK_NODE_INK_RGB));
    const lightContrast = contrastRatio(fillLuminance, relativeLuminance(LIGHT_NODE_INK_RGB));
    const ink = darkContrast >= lightContrast ? DARK_NODE_INK : LIGHT_NODE_INK;

    label.style.setProperty('color', ink, 'important');
    for (const text of label.querySelectorAll<SVGElement>('text, tspan')) {
      text.style.setProperty('fill', ink, 'important');
    }
  }
}

function hasAuthoredFill(element: SVGElement): boolean {
  const declaration = element.getAttribute('style') ?? '';
  return (
    /(?:^|;)\s*fill\s*:/i.test(declaration) &&
    !/(?:^|;)\s*fill\s*:\s*(?:none|transparent)\b/i.test(declaration)
  );
}

function hasAuthoredLabelColour(label: SVGElement): boolean {
  const declarations = [label, ...label.querySelectorAll<SVGElement>('text, tspan')]
    .map((element) => element.getAttribute('style') ?? '')
    .join(';');
  return /(?:^|;)\s*(?:color|fill)\s*:/i.test(declarations);
}

interface RgbColour {
  red: number;
  green: number;
  blue: number;
  alpha: number;
}

function parseComputedRgb(value: string): RgbColour | null {
  const hex = value.trim().match(/^#([\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i)?.[1];
  if (hex) {
    const expanded = hex.length <= 4 ? Array.from(hex, (digit) => digit + digit).join('') : hex;
    return {
      red: Number.parseInt(expanded.slice(0, 2), 16),
      green: Number.parseInt(expanded.slice(2, 4), 16),
      blue: Number.parseInt(expanded.slice(4, 6), 16),
      alpha: expanded.length === 8 ? Number.parseInt(expanded.slice(6, 8), 16) / 255 : 1,
    };
  }
  const match = value.match(
    /^rgba?\(\s*([\d.]+)[, ]+\s*([\d.]+)[, ]+\s*([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/i,
  );
  if (!match) return null;
  const alphaValue = match[4];
  const alpha = alphaValue?.endsWith('%')
    ? Number.parseFloat(alphaValue) / 100
    : Number.parseFloat(alphaValue ?? '1');
  return {
    red: Number.parseFloat(match[1]!),
    green: Number.parseFloat(match[2]!),
    blue: Number.parseFloat(match[3]!),
    alpha,
  };
}

function relativeLuminance({ red, green, blue }: RgbColour): number {
  const linear = (channel: number) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue);
}

function contrastRatio(first: number, second: number): number {
  const lighter = Math.max(first, second);
  const darker = Math.min(first, second);
  return (lighter + 0.05) / (darker + 0.05);
}

interface DiagramControls {
  element: HTMLElement;
  mount: () => () => void;
}

function createDiagramControls(
  viewport: HTMLElement,
  svg: SVGElement,
  onEdit?: () => void,
): DiagramControls {
  const document = viewport.ownerDocument;
  const element = document.createElement('div');
  element.className = 'md-mermaid-controls';
  element.setAttribute('aria-label', onEdit ? 'Diagram controls' : 'Diagram zoom controls');

  const status = document.createElement('output');
  status.className = 'md-mermaid-scale';
  status.setAttribute('aria-live', 'polite');

  const fitButton = controlButton(document, 'Fit', 'Fit diagram to available width');
  const actualButton = controlButton(document, '1:1', 'Show diagram at its natural size');
  const outButton = controlButton(document, '−', 'Zoom out');
  const inButton = controlButton(document, '+', 'Zoom in');
  const editButton = onEdit ? controlButton(document, 'Edit', 'Edit Mermaid source') : null;
  element.append(...(editButton ? [editButton] : []), fitButton, actualButton, outButton, status, inButton);

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
      editButton?.addEventListener('click', onEdit!);
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
        editButton?.removeEventListener('click', onEdit!);
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

/** Read the wrapper's nonced source stamp without trusting any authored attribute name. */
export function sourceRangeFromDiagram(root: Element, element: Element): SourceRange | null {
  const nonce = root.getAttribute('data-marky-mcmarkface-nonce');
  const attribute = nonce ? `data-marky-mcmarkface-pos-${nonce}` : 'data-marky-mcmarkface-pos';
  const raw = element.getAttribute(attribute);
  if (!raw) return null;
  const separator = raw.indexOf(':');
  if (separator === -1) return null;
  const start = Number(raw.slice(0, separator));
  const end = Number(raw.slice(separator + 1));
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) return null;
  return { side: 'RIGHT', start, end };
}

/** Preserve Markdown fences (or a standalone file's final newline) around edited Mermaid source. */
export function replacementForMermaid(
  documentSource: string,
  range: SourceRange,
  originalSource: string,
  nextSource: string,
): string | null {
  if (range.start < 0 || range.end > documentSource.length || range.end <= range.start) return null;
  const authoredBlock = documentSource.slice(range.start, range.end);
  const sourceStart = authoredBlock.indexOf(originalSource);
  if (sourceStart === -1) return null;
  return (
    authoredBlock.slice(0, sourceStart) +
    nextSource +
    authoredBlock.slice(sourceStart + originalSource.length)
  );
}

async function renderMermaidSvg(source: string, theme: 'light' | 'dark'): Promise<string> {
  if (source.length > MAX_SOURCE_LENGTH) {
    throw new Error('diagram source exceeds the rendering limit');
  }
  return enqueue(async () => {
    const mermaid = (await import('mermaid')).default;
    mermaid.initialize(configFor(theme));
    const result = await mermaid.render(`marky-mermaid-${++sequence}`, source);
    return sanitizeMermaidSvg(result.svg, DOMPurify);
  });
}

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const next = renderQueue.then(task, task);
  renderQueue = next.then(
    () => undefined,
    () => undefined,
  );
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
