import { SiteConfig, CheckResult, Finding } from '../../types.js'
import { secureFetch, baseUrl, logger } from '../../utils.js'
import type { BrowserSession } from '../browser-session.js'

export async function runSeoCheck(config: SiteConfig, session?: BrowserSession): Promise<CheckResult> {
  const startTime = Date.now()
  const base = baseUrl(config.store_url)
  const findings: Finding[] = []

  logger.debug(`Running SEO check for ${base}`)

  // Homepage HTML via the shared authenticated session so password-protected
  // stores are scanned on the real homepage — not the /password gate, whose
  // bare HTML (only a <title>) produced false "missing meta description / OG /
  // canonical / schema" findings. getHomeHtml() is the rendered DOM, so it also
  // sees JS-injected tags. Falls back to a plain fetch for public stores.
  const html = session
    ? await session.getHomeHtml()
    : await secureFetch(`${base}/`, { timeout: 30000 })
        .then((r) => r.text())
        .catch(() => '')

  // Fetch a sub-resource (sitemap/robots) through the authenticated session so
  // a locked store doesn't report them "missing" just because the gate hid them.
  const fetchDoc = (url: string) =>
    session
      ? session.fetchDoc(url, { timeoutMs: 10000 })
      : secureFetch(url, { timeout: 10000 })
          .then((r) => ({ ok: r.ok, status: r.status, text: '' }))
          .catch(() => ({ ok: false, status: 0, text: '' }))

  // ── Check 1: Meta Title ────────────────────────────────────────────────

  const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i)
  const title = titleMatch?.[1] || ''
  if (!title) {
    findings.push({
      id: 'missing-title',
      severity: 'high',
      title: 'Missing page title',
      description: 'Page title tag is missing or empty. Critical for SEO and accessibility.',
      recommendation: 'Add a descriptive title tag (50-60 characters).',
    })
  } else if (title.length > 60) {
    findings.push({
      id: 'title-too-long',
      severity: 'low',
      title: `Page title too long (${title.length} chars)`,
      description: 'Title will be truncated in search results.',
      recommendation: 'Keep title under 60 characters.',
      evidence: title,
    })
  }

  // ── Check 2: Meta Description ──────────────────────────────────────────

  const descMatch = html.match(/<meta\s+name=["']description["'][^>]*content=["']([^"']*)["']/i)
  if (!descMatch?.[1]) {
    findings.push({
      id: 'missing-description',
      severity: 'high',
      title: 'Missing meta description',
      description: 'Meta description is missing. It appears in search results.',
      recommendation: 'Add a compelling description (150-160 characters).',
    })
  }

  // ── Check 3: Open Graph Tags ───────────────────────────────────────────

  if (!(html.includes('og:title') || html.includes('og:image'))) {
    findings.push({
      id: 'missing-og-tags',
      severity: 'low',
      title: 'Missing Open Graph tags',
      description: 'Open Graph tags improve sharing on social media.',
      recommendation: 'Add og:title, og:description, og:image meta tags.',
    })
  }

  // ── Check 4: Sitemap ───────────────────────────────────────────────────

  const sitemap = await fetchDoc(`${base}/sitemap.xml`)
  if (!sitemap.ok) {
    findings.push({
      id: 'missing-sitemap',
      severity: 'medium',
      title: 'Sitemap not found',
      description: '/sitemap.xml is missing. Helps search engines crawl your store.',
      recommendation: 'Shopify auto-generates sitemap.xml. Verify it exists at /sitemap.xml',
    })
  }

  // ── Check 5: Structured Data ───────────────────────────────────────────

  if (!(html.includes('schema.org') || html.includes('application/ld+json'))) {
    findings.push({
      id: 'missing-schema',
      severity: 'low',
      title: 'Missing structured data (schema.org)',
      description: 'Structured data helps search engines understand content.',
      recommendation: 'Add JSON-LD structured data for Organization, Product, BreadcrumbList.',
    })
  }

  // ── Check 6: robots.txt ────────────────────────────────────────────────

  const robots = await fetchDoc(`${base}/robots.txt`)
  if (!robots.ok) {
    findings.push({
      id: 'missing-robots-txt',
      severity: 'low',
      title: 'robots.txt not found',
      description: 'robots.txt helps control how search engines crawl your site.',
      recommendation: 'Create /robots.txt to allow search engine crawling.',
    })
  }

  // ── Check 7: Canonical URL ─────────────────────────────────────────────

  if (!html.includes('rel="canonical"')) {
    findings.push({
      id: 'missing-canonical',
      severity: 'low',
      title: 'Missing canonical URL',
      description: 'Canonical URL prevents duplicate content issues.',
      recommendation: 'Add <link rel="canonical" href=""> to main pages.',
    })
  }

  return {
    id: 'seo',
    name: 'SEO Audit',
    status: findings.filter((f) => f.severity === 'critical' || f.severity === 'high').length > 0 ? 'warning' : 'pass',
    duration_ms: Date.now() - startTime,
    findings,
  }
}
