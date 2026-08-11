import DOMPurify from 'dompurify';
import type { Config, DOMPurify as DOMPurifyInstance, UponSanitizeAttributeHook } from 'dompurify';

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

export function sanitizeRenderedHtml(html: string, purifier: DOMPurifyInstance = DOMPurify): string {
  purifier.addHook('uponSanitizeAttribute', restrictResourceLoads);
  try {
    return purifier.sanitize(html, CONFIG);
  } finally {
    purifier.removeHook('uponSanitizeAttribute', restrictResourceLoads);
  }
}
