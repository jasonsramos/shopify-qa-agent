import { SiteConfig, CheckResult, Finding } from '../../types.js'
import { secureFetch, baseUrl, logger } from '../../utils.js'

export async function runPageHealthCheck(config: SiteConfig): Promise<CheckResult> {
  const startTime = Date.now()
  const base = baseUrl(config.store_url)
  const findings: Finding[] = []

  logger.debug(`Running page health check for ${base}`)

  // ── Detect password-locked storefront ──────────────────────────────────
  try {
    const homeResponse = await secureFetch(`${base}/`, { timeout: 10000 })
    const homeHtml = await homeResponse.text()
    const isLocked =
      homeHtml.includes('password') &&
      (homeHtml.includes('Enter store using password') ||
        homeHtml.includes('password_form') ||
        homeHtml.includes('storefront-password') ||
        homeHtml.includes('Store is currently unavailable') ||
        homeHtml.match(/type=["']password["'][^>]*name=["']password["']/i) !== null)

    if (isLocked) {
      // If storefront_password is configured, the user has already set up bypass — downgrade to info.
      // Otherwise, this is a critical blocker (public lock prevents all testing).
      const hasPasswordBypass = !!config.storefront_password
      findings.push({
        id: 'storefront-password-locked',
        severity: hasPasswordBypass ? 'info' : 'critical',
        title: 'Storefront is password-protected',
        description: hasPasswordBypass
          ? 'Store is password-protected (dev store). Password bypass is configured — real store was tested.'
          : 'The store is locked with a password. All browser-based checks (checkout, responsive, accessibility) are testing the password page — not the real store. Results for those checks are invalid until the store is unlocked.',
        recommendation: hasPasswordBypass
          ? undefined
          : 'Disable the storefront password: Shopify Admin → Online Store → Preferences → Password protection → uncheck "Restrict access".',
      })
      if (!hasPasswordBypass) {
        logger.warn('⚠️  Storefront is password-protected — browser checks will test the lock page')
      }
    }
  } catch {
    // ignore detection failure
  }

  const pages = [
    { name: 'Homepage', path: '/' },
    { name: 'Products', path: '/products' },
    { name: 'Cart', path: '/cart' },
    { name: 'Checkout', path: '/checkout' },
    { name: 'About', path: '/about' },
    ...config.key_pages.map((p) => ({ name: p, path: p })),
  ]

  const uniquePages = Array.from(new Map(pages.map((p) => [p.path, p])).values())

  for (const page of uniquePages) {
    try {
      const response = await secureFetch(`${base}${page.path}`, {
        timeout: 15000,
        redirect: 'manual',
      })

      if (response.status === 404) {
        findings.push({
          id: `page-404-${page.path}`,
          severity: 'medium',
          title: `404 Not Found: ${page.path}`,
          description: `Page ${page.path} returned 404. Users cannot access this page.`,
          recommendation: 'Verify page exists or restore it.',
        })
      } else if (response.status === 500) {
        findings.push({
          id: `page-500-${page.path}`,
          severity: 'critical',
          title: `500 Server Error: ${page.path}`,
          description: `Page ${page.path} returned 500. There's a server error.`,
          recommendation: 'Check error logs and fix server issues.',
        })
      } else if (response.status >= 300 && response.status < 400) {
        const redirectTo = response.headers.get('location')
        findings.push({
          id: `page-redirect-${page.path}`,
          severity: 'info',
          title: `Page redirects: ${page.path} → ${redirectTo}`,
          description: `Page ${page.path} redirects to ${redirectTo}.`,
        })
      }
    } catch (err: any) {
      findings.push({
        id: `page-error-${page.path}`,
        severity: 'high',
        title: `Page unreachable: ${page.path}`,
        description: `Cannot access ${page.path}: ${err.message}`,
        recommendation: 'Verify page is accessible and server is online.',
      })
    }
  }

  return {
    id: 'page-health',
    name: 'Page Health Check',
    status: findings.filter((f) => f.severity === 'critical').length > 0 ? 'fail' : findings.filter((f) => f.severity === 'high').length > 0 ? 'warning' : 'pass',
    duration_ms: Date.now() - startTime,
    findings,
  }
}
