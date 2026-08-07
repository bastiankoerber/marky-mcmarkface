/**
 * Browser policy shared by the production server and the Vite development server.
 *
 * Pull request content is untrusted. In particular, remote images and media can disclose that a
 * private document was opened even when no script runs. Keeping the policy in one module prevents
 * development — the documented way to run Marky McMarkface today — from silently losing that protection.
 */
export function contentSecurityPolicy(viteDevelopment = false): string {
  const connect = viteDevelopment
    ? "'self' ws://localhost:5180 ws://127.0.0.1:5180"
    : "'self'";
  // Vite's React refresh preamble is injected inline in development. Production has no inline
  // scripts and keeps the stricter policy; hostile Markdown is sanitised in both environments.
  const scripts = viteDevelopment ? "'self' 'unsafe-inline'" : "'self'";

  return [
    "default-src 'self'",
    `script-src ${scripts}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https://*.githubusercontent.com https://avatars.githubusercontent.com",
    "media-src 'none'",
    "font-src 'self'",
    `connect-src ${connect}`,
    "form-action 'none'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

export function browserSecurityHeaders(viteDevelopment = false): Record<string, string> {
  return {
    'Content-Security-Policy': contentSecurityPolicy(viteDevelopment),
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
  };
}
