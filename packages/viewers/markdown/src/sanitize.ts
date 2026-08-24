import DOMPurify from 'dompurify';
import type {
  Config,
  DOMPurify as DOMPurifyInstance,
  UponSanitizeAttributeHook,
  UponSanitizeElementHook,
} from 'dompurify';

const CONFIG: Config = {
  // ALLOW_DATA_ATTR defaults true, preserving the nonced position stamps used for anchoring.
  ADD_TAGS: ['ins', 'del'],
  // DOMPurify strips target by default. It is safe because the renderer always supplies rel.
  ADD_ATTR: ['target'],
  FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'button'],
  // style/class are review-integrity controls: PR content must not hide itself or imitate chrome.
  FORBID_ATTR: ['style', 'class', 'srcdoc', 'formaction', 'ping'],
};

function isAllowedImageUrl(raw: string): boolean {
  const value = raw.trim();
  if (!value) return false;
  if (/^data:image\//i.test(value)) return true;

  // Plain and root-relative paths stay on Marky McMarkface's own origin. Protocol-relative URLs do not.
  if (!/^[a-z][a-z\d+.-]*:/i.test(value) && !value.startsWith('//')) return true;

  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      (url.hostname === 'avatars.githubusercontent.com' ||
        url.hostname.endsWith('.githubusercontent.com') ||
        (url.hostname === 'github.com' && url.pathname.startsWith('/user-attachments/assets/')))
    );
  } catch {
    return false;
  }
}

/**
 * DOMPurify prevents script execution; this hook prevents passive network exfiltration.
 *
 * Only images from Marky McMarkface itself, data URLs, or GitHub's image hosts may load automatically.
 * Media, srcset/poster, and SVG resource references are removed. Ordinary anchor hrefs remain so
 * a reviewer can still choose to follow a link.
 */
const restrictResourceLoads: UponSanitizeAttributeHook = (node, event) => {
  const attribute = event.attrName.toLowerCase();
  const tag = node.tagName.toLowerCase();

  if (attribute === 'src') {
    if (tag !== 'img' || !isAllowedImageUrl(event.attrValue)) event.keepAttr = false;
    return;
  }

  if (attribute === 'srcset' || attribute === 'poster') {
    event.keepAttr = false;
    return;
  }

  if ((attribute === 'href' || attribute === 'xlink:href') && (tag === 'image' || tag === 'use')) {
    event.keepAttr = false;
  }
};

function hasExternalCssLoad(value: string): boolean {
  // SVG legitimately uses url(#local-marker) for arrows and filters. Remove those first; any
  // remaining url(), @import, or legacy expression() can reach beyond the generated diagram.
  const withoutLocalFragments = value.replace(/url\(\s*(["']?)#[^)"']+\1\s*\)/gi, '');
  return /url\s*\(|@import|expression\s*\(/i.test(withoutLocalFragments);
}

const restrictMermaidPresentation: UponSanitizeAttributeHook = (node, event) => {
  if (hasExternalCssLoad(event.attrValue)) event.keepAttr = false;
  if (
    (event.attrName.toLowerCase() === 'href' || event.attrName.toLowerCase() === 'xlink:href') &&
    node.tagName.toLowerCase() === 'a'
  ) {
    event.keepAttr = isAllowedLinkUrl(event.attrValue);
  }
};

function isAllowedLinkUrl(raw: string): boolean {
  const value = raw.trim();
  if (!value || value.startsWith('//') || value.startsWith('\\') || /[\u0000-\u001f\u007f]/.test(value)) return false;
  if (!/^[a-z][a-z\d+.-]*:/i.test(value)) return true;
  try {
    return ['https:', 'http:', 'mailto:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

const restrictMermaidStyles: UponSanitizeElementHook = (node, event) => {
  if (event.tagName === 'style' && hasExternalCssLoad(node.textContent ?? '')) node.textContent = '';
};

export function sanitizeRenderedHtml(html: string, purifier: DOMPurifyInstance = DOMPurify): string {
  purifier.addHook('uponSanitizeAttribute', restrictResourceLoads);
  try {
    return purifier.sanitize(html, CONFIG);
  } finally {
    purifier.removeHook('uponSanitizeAttribute', restrictResourceLoads);
  }
}

/**
 * Mermaid produces SVG rather than authored HTML. Keep its presentation attributes, but run the
 * result through an SVG-only profile and the same no-network boundary as Markdown images.
 */
export function sanitizeMermaidSvg(svg: string, purifier: DOMPurifyInstance = DOMPurify): string {
  purifier.addHook('uponSanitizeAttribute', restrictResourceLoads);
  purifier.addHook('uponSanitizeAttribute', restrictMermaidPresentation);
  purifier.addHook('uponSanitizeElement', restrictMermaidStyles);
  try {
    return purifier.sanitize(svg, {
      USE_PROFILES: { svg: true, svgFilters: true },
      FORBID_TAGS: ['script', 'foreignObject', 'iframe', 'object', 'embed'],
      FORBID_ATTR: ['srcdoc', 'formaction', 'ping'],
    });
  } finally {
    purifier.removeHook('uponSanitizeAttribute', restrictResourceLoads);
    purifier.removeHook('uponSanitizeAttribute', restrictMermaidPresentation);
    purifier.removeHook('uponSanitizeElement', restrictMermaidStyles);
  }
}
