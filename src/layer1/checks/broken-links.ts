import { SiteConfig, CheckResult, Finding } from '../../types.js'
import { secureFetch, baseUrl, logger } from '../../utils.js'
import type { BrowserSession } from '../browser-session.js'

export async function runBrokenLinksCheck(config: SiteConfig, session?: BrowserSession): Promise<CheckResult> {
  const startTime = Date.now()
  const base = baseUrl(config.store_url)
  const findings: Finding[] = []

  logger.debug(`Running broken links check for ${base}`)

  // Real homepage via the shared authenticated session — on password-protected
  // stores an unauthenticated fetch only sees the /password gate (a single
  // link), so no real store links were ever tested (a hollow "pass").
  const html = session
    ? await session.getHomeHtml()
    : await secureFetch(`${base}/`, { timeout: 30000 })
        .then((r) => r.text())
        .catch(() => '')

  // Only navigational <a href> links — not <link rel="stylesheet"/"preconnect">
  // or other asset hrefs, which aren't "broken links" and skew the result.
  const linkRegex = /<a\b[^>]*\bhref=["']([^"']+)["']/gi
  const links = new Set<string>()
  let match
  while ((match = linkRegex.exec(html)) !== null) {
    links.add(match[1])
  }

  for (const link of Array.from(links).slice(0, 20)) {
    // Resolve against the base with the URL constructor so protocol-relative
    // (//host/path), root-relative (/path) and absolute hrefs all normalize
    // correctly. Naive base+link concatenation mangled //host/... into
    // https://host//host/... and produced false 404s.
    let url: string
    try {
      const u = new URL(link, base)
      if (u.protocol !== 'http:' && u.protocol !== 'https:') continue // skip mailto:/tel:/#/js
      url = u.href
    } catch {
      continue
    }

    try {
      // Validate through the authenticated session so internal links aren't
      // themselves redirected to the /password gate. maxRedirects: 0 keeps the
      // original manual-redirect semantics (only a real 404 is flagged).
      const res = session
        ? await session.fetchDoc(url, { method: 'HEAD', maxRedirects: 0, timeoutMs: 5000 })
        : await secureFetch(url, { method: 'HEAD', timeout: 5000, redirect: 'manual' })
            .then((r) => ({ ok: r.ok, status: r.status, text: '' }))
            .catch(() => null)

      if (res && res.status === 404) {
        findings.push({
          id: `broken-link-${link}`,
          severity: 'medium',
          title: `Broken link: ${link}`,
          description: `Link returns 404 Not Found.`,
          recommendation: 'Fix or remove broken link.',
        })
      }
    } catch {
      // Skip unreachable links
    }
  }

  return {
    id: 'broken-links',
    name: 'Broken Links Check',
    status: findings.length > 0 ? 'warning' : 'pass',
    duration_ms: Date.now() - startTime,
    findings,
  }
}
