import { SiteConfig, CheckResult, Finding } from '../../types.js'
import { baseUrl, secureFetch, logger } from '../../utils.js'
import type { BrowserSession } from '../browser-session.js'

export async function runShopifyAnalyticsCheck(
  config: SiteConfig,
  session?: BrowserSession
): Promise<CheckResult> {
  const startTime = Date.now()
  const findings: Finding[] = []

  try {
    const base = baseUrl(config.store_url)
    // Prefer the shared authenticated session: on password-protected stores a
    // plain fetch of `/` is 302-redirected to the /password gate, whose HTML
    // contains no analytics — producing a false "no tracking detected" finding.
    // getHomeHtml() returns the rendered homepage behind the password bypass,
    // and (being the executed DOM) also surfaces JS-injected GA4/GTM/pixels.
    let html: string
    if (session) {
      html = await session.getHomeHtml()
    } else {
      const response = await secureFetch(base, { timeout: 10000 })
      html = await response.text()
    }

    // GA4 detection
    const ga4Match = html.match(/gtag\(['"]config['"],\s*['"]G-([A-Z0-9]+)['"]\)/g)
    const ga4Ids = ga4Match ? [...new Set(ga4Match)] : []

    // GTM detection
    const gtmMatch = html.match(/GTM-[A-Z0-9]+/g)
    const gtmIds = gtmMatch ? [...new Set(gtmMatch)] : []

    // Meta Pixel detection
    const metaPixelMatch = html.match(/fbq\(['"]init['"],\s*['"](\d+)['"]\)/g)
    const metaPixelIds = metaPixelMatch ? [...new Set(metaPixelMatch)] : []

    // TikTok Pixel detection
    const tiktokMatch = html.match(/ttq\.track\(['"]PageView['"]\)/g)
    const hasTiktok = !!tiktokMatch

    // Universal Analytics detection (legacy)
    const uaMatch = html.match(/UA-\d+-\d+/g)
    const uaIds = uaMatch ? [...new Set(uaMatch)] : []

    // Check for duplicates
    if (ga4Ids.length > 1) {
      findings.push({
        id: 'analytics-duplicate-ga4',
        severity: 'high',
        title: `${ga4Ids.length} GA4 measurement IDs found (duplicate tracking)`,
        description: `Found multiple GA4 tracking codes: ${ga4Ids.join(', ')}. This causes double-counting of events.`,
        recommendation: 'Remove duplicate GA4 tracking code. Keep only one measurement ID.',
      })
    }

    // Check for UA + GA4 together
    if (uaIds.length > 0 && ga4Ids.length > 0) {
      findings.push({
        id: 'analytics-ua-and-ga4',
        severity: 'medium',
        title: 'Both Universal Analytics (UA) and GA4 detected',
        description: `Found legacy UA tracking (${uaIds[0]}) and modern GA4 tracking. UA is deprecated since July 2023.`,
        recommendation: 'Remove Universal Analytics code. Use GA4 only.',
      })
    }

    // Check for GTM
    if (gtmIds.length > 0) {
      findings.push({
        id: 'analytics-gtm-found',
        severity: 'info',
        title: `Google Tag Manager configured (${gtmIds[0]})`,
        description: 'GTM is properly installed and will manage analytics tags.',
      })
    }

    // Check for Meta Pixel
    if (metaPixelIds.length > 0) {
      findings.push({
        id: 'analytics-meta-pixel-found',
        severity: 'info',
        title: 'Meta (Facebook) Pixel configured',
        description: 'Meta Pixel is installed for conversion tracking and retargeting.',
      })
    }

    // Check for TikTok
    if (hasTiktok) {
      findings.push({
        id: 'analytics-tiktok-found',
        severity: 'info',
        title: 'TikTok Pixel configured',
        description: 'TikTok Pixel is installed for TikTok shop integration.',
      })
    }

    // Warning if no tracking at all
    if (ga4Ids.length === 0 && gtmIds.length === 0 && metaPixelIds.length === 0 && uaIds.length === 0 && !hasTiktok) {
      findings.push({
        id: 'analytics-no-tracking',
        severity: 'high',
        title: 'No analytics tracking detected',
        description: 'No GA4, GTM, Meta Pixel, TikTok, or UA tracking found on homepage.',
        recommendation: 'Install Google Analytics 4 (GA4) to track store performance. Go to Admin → Apps and sales channels → Apps.',
      })
    }

    if (findings.length === 0) {
      findings.push({
        id: 'analytics-configured',
        severity: 'info',
        title: 'Analytics properly configured',
        description: `GA4 (${ga4Ids.length ? ga4Ids[0].match(/G-[A-Z0-9]+/)?.[0] : 'none'}) detected. Tracking is working.`,
      })
    }

    return {
      id: 'shopify-analytics',
      name: 'Shopify Analytics Check',
      status: findings.some((f) => f.severity === 'high') ? 'fail' : findings.some((f) => f.severity === 'medium') ? 'warning' : 'pass',
      duration_ms: Date.now() - startTime,
      findings,
    }
  } catch (err: any) {
    logger.debug(`Analytics check error: ${err.message}`)
    findings.push({
      id: 'analytics-check-error',
      severity: 'high',
      title: 'Analytics check failed',
      description: `Could not check analytics: ${err.message}`,
    })

    return {
      id: 'shopify-analytics',
      name: 'Shopify Analytics Check',
      status: 'fail',
      duration_ms: Date.now() - startTime,
      findings,
    }
  }
}
