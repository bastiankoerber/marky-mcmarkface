# Bundled typefaces

Self-hosted so the Content-Security-Policy can stay at `font-src 'self'` — nothing is fetched
from a font CDN at runtime, which also means no third party learns what you are reading.

| File | Family | Licence |
|---|---|---|
| `public-sans-*.woff2` | Public Sans (variable 300–800) | SIL OFL 1.1; US Government modifications dedicated to the public domain (CC0) |
| `newsreader-*.woff2` | Newsreader (variable, optical size 6–72) | SIL OFL 1.1 |
| `commit-mono-400.woff2` | Commit Mono 1.143 | SIL OFL 1.1 |

Public Sans and Newsreader are the Latin subsets as distributed by Google Fonts, under their
original family names. Commit Mono is converted from the upstream release's ttfautohint TTFs to
woff2 with no other modification, also under its original name.

**If you replace or subset any of these, do not rename them and do not keep the original family
name if you have modified the outlines.** The OFL's Reserved Font Name clause is not decorative:
Zed had to remove a font and ship stock IBM Plex instead after shipping a modified build under
the reserved "Plex" name.

Licence texts are alongside the fonts in this directory.
