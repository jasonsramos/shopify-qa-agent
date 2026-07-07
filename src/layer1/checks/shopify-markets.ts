import { SiteConfig, CheckResult, Finding } from '../../types.js'
import { baseUrl, secureFetch, logger } from '../../utils.js'

export async function runShopifyMarketsCheck(config: SiteConfig): Promise<CheckResult> {
  const startTime = Date.now()
  const findings: Finding[] = []

  try {
    const base = baseUrl(config.store_url)
    const response = await secureFetch(base, { timeout: 10000 })
    const html = await response.text()

    // Check for hreflang tags (indicates multi-language/market setup)
    const hreflangs = html.match(/<link\s+rel=["']alternate["']\s+hreflang=["'][^"']+["']/gi) || []
    const hreflangsSet = new Set(hreflangs)

    // Check for language selector (common pattern)
    const hasLanguageSelector = /language|lang[-_]selector|currency[-_]selector/i.test(html)

    // Check for geo-redirect indicators
    const hasGeoRedirect = /geo[-_]?redirect|locali[sz]e|accept[-_]language/i.test(html)

    // Detect common multi-language solutions
    const hasWEGLOT = html.includes('wglnjs.com') || html.includes('weglot')
    const hasTranslatePress = html.includes('translatepress') || html.includes('trp-loader')
    const hasPolylang = html.includes('polylang') || html.includes('pll_')
    const hasWPML = html.includes('wpml') || html.includes('ICL_')

    const hasMultiLanguage = hreflangsSet.size > 1 || hasLanguageSelector || hasWEGLOT || hasTranslatePress

    if (hasMultiLanguage) {
      let detectedServices = []
      if (hreflangsSet.size > 1) detectedServices.push(`${hreflangsSet.size} hreflang tags`)
      if (hasWEGLOT) detectedServices.push('Weglot')
      if (hasTranslatePress) detectedServices.push('TranslatePress')
      if (hasPolylang) detectedServices.push('Polylang')
      if (hasWPML) detectedServices.push('WPML')
      if (hasLanguageSelector) detectedServices.push('Language selector')

      findings.push({
        id: 'markets-multi-language-detected',
        severity: 'info',
        title: 'Multi-language/Markets setup detected',
        description: `Store appears to support multiple languages: ${detectedServices.join(', ')}.`,
        recommendation: 'Verify all languages have complete translations and hreflang tags are correct for SEO.',
      })

      // Check hreflang validity
      if (hreflangsSet.size > 1) {
        findings.push({
          id: 'markets-hreflang-present',
          severity: 'info',
          title: `Found ${hreflangsSet.size} hreflang tags`,
          description: 'Store uses hreflang for proper multi-language SEO. This tells search engines about language variants.',
        })
      }
    } else {
      findings.push({
        id: 'markets-single-language',
        severity: 'info',
        title: 'Single language store detected',
        description: 'Store appears to be in a single language/market. No multi-language setup found.',
      })
    }

    // Check for Shopify Markets (Shopify native feature)
    // This is harder to detect without Admin API, so we add a note
    if (!config.admin_access_token) {
      findings.push({
        id: 'markets-check-admin',
        severity: 'info',
        title: 'Shopify Markets configuration (Admin API check)',
        description: 'To verify Shopify Markets (native multi-currency/language), check Admin → Settings → Markets.',
      })
    }

    return {
      id: 'shopify-markets',
      name: 'Shopify Markets & Languages',
      status: 'pass',
      duration_ms: Date.now() - startTime,
      findings,
    }
  } catch (err: any) {
    logger.debug(`Markets check error: ${err.message}`)
    findings.push({
      id: 'markets-check-error',
      severity: 'high',
      title: 'Markets check failed',
      description: `Could not check markets setup: ${err.message}`,
    })

    return {
      id: 'shopify-markets',
      name: 'Shopify Markets & Languages',
      status: 'fail',
      duration_ms: Date.now() - startTime,
      findings,
    }
  }
}
