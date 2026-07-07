import { SiteConfig, CheckResult, Finding } from '../../types.js'
import { baseUrl, logger } from '../../utils.js'
import { BrowserSession } from '../browser-session.js'

interface ErrorRecord {
  type: 'console' | 'network'
  severity: 'error' | 'warning'
  message: string
  url?: string
  status?: number
  page: string
}

export async function runConsoleNetworkErrorsCheck(config: SiteConfig, sharedSession?: BrowserSession): Promise<CheckResult> {
  const startTime = Date.now()
  const base = baseUrl(config.store_url)
  const findings: Finding[] = []
  const errors: ErrorRecord[] = []

  logger.debug(`Running console & network errors check for ${base}`)

  const pages = [
    { path: '/', name: 'Homepage' },
    { path: '/products', name: 'Products' },
    config.test_checkout ? { path: '/cart', name: 'Cart' } : null,
    config.test_checkout ? { path: '/checkout', name: 'Checkout' } : null,
  ].filter(Boolean) as { path: string; name: string }[]

  let owned = false
  let session: BrowserSession | null = null
  try {
    ;({ session, owned } = await BrowserSession.acquire(config, sharedSession))

    for (const page of pages) {
      try {
        const browserPage = await session.newPage()

        // Collect console messages
        browserPage.on('console', (msg) => {
          if (msg.type() === 'error' || msg.type() === 'warning') {
            errors.push({
              type: 'console',
              severity: msg.type() === 'error' ? 'error' : 'warning',
              message: msg.text(),
              page: page.name,
            })
          }
        })

        // Collect network failures
        browserPage.on('response', (response) => {
          const status = response.status()
          const url = response.url()

          // Flag 5xx errors and critical endpoints that fail
          if (status >= 500) {
            const isCritical = url.includes('/checkout') || url.includes('/cart') || url.includes('/payment')
            errors.push({
              type: 'network',
              severity: 'error',
              message: `${status} error on ${url}`,
              url,
              status,
              page: page.name,
            })
          }
        })

        // Use domcontentloaded — Shopify analytics (Klaviyo/GTM) keep the network busy so
        // 'networkidle' never fires and would burn the whole timeout.
        await browserPage.goto(`${base}${page.path}`, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => null)

        // Brief settle for async errors/requests to surface
        await browserPage.waitForTimeout(1500)

        await browserPage.close()
      } catch (err: any) {
        errors.push({
          type: 'console',
          severity: 'warning',
          message: `Failed to test ${page.name}: ${err.message}`,
          page: page.name,
        })
      }
    }

    // Group errors by severity
    const criticalErrors = errors.filter((e) => e.severity === 'error')
    const warningErrors = errors.filter((e) => e.severity === 'warning')

    // Group by page and error type
    const errorsByPage: { [key: string]: ErrorRecord[] } = {}
    errors.forEach((err) => {
      if (!errorsByPage[err.page]) {
        errorsByPage[err.page] = []
      }
      errorsByPage[err.page].push(err)
    })

    // Create findings for each page with errors
    for (const [pageName, pageErrors] of Object.entries(errorsByPage)) {
      const pageConsoleErrors = pageErrors.filter((e) => e.type === 'console' && e.severity === 'error')
      const pageNetworkErrors = pageErrors.filter((e) => e.type === 'network')
      const pageWarnings = pageErrors.filter((e) => e.severity === 'warning')

      if (pageConsoleErrors.length > 0 || pageNetworkErrors.length > 0) {
        const severity = pageNetworkErrors.some((e) => e.message.includes('/checkout') || e.message.includes('/payment'))
          ? 'critical'
          : pageConsoleErrors.length > 0
            ? 'high'
            : 'medium'

        const errorMessages = [
          ...pageConsoleErrors.map((e) => `🔴 Console Error: ${e.message}`),
          ...pageNetworkErrors.map((e) => `🔴 Network ${e.status}: ${e.url}`),
          ...pageWarnings.map((e) => `🟡 Warning: ${e.message}`),
        ]

        findings.push({
          id: `console-network-${pageName.toLowerCase().replace(/\s+/g, '-')}`,
          severity,
          title: `Console & Network errors on ${pageName}`,
          description: `Found ${pageConsoleErrors.length} console error(s), ${pageNetworkErrors.length} network error(s), and ${pageWarnings.length} warning(s) on ${pageName}.`,
          recommendation:
            severity === 'critical'
              ? 'Critical: Payment/checkout endpoints are failing. Fix immediately.'
              : 'Review browser console and network tab in DevTools. Check error logs.',
          evidence: errorMessages,
        })
      }
    }

    // Summary finding if no errors
    if (findings.length === 0) {
      findings.push({
        id: 'console-network-clean',
        severity: 'info',
        title: 'No console or network errors detected',
        description: `Tested ${pages.length} pages. No JavaScript errors or network failures found.`,
      })
    }
  } catch (err: any) {
    findings.push({
      id: 'console-network-browser-error',
      severity: 'high',
      title: 'Could not run console & network monitoring',
      description: `Browser automation failed: ${err.message}`,
      recommendation: 'Check Playwright installation and network connectivity.',
    })
  } finally {
    if (owned && session) await session.close()
  }

  return {
    id: 'console-network-errors',
    name: 'Console & Network Errors',
    status: findings.some((f) => f.severity === 'critical') ? 'fail' : findings.some((f) => f.severity === 'high') ? 'warning' : 'pass',
    duration_ms: Date.now() - startTime,
    findings,
  }
}
