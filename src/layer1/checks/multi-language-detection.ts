import { SiteConfig, CheckResult, Finding } from '../../types.js'
import { baseUrl, secureFetch, logger } from '../../utils.js'
import { chromium } from 'playwright'

export async function runMultiLanguageDetectionCheck(config: SiteConfig): Promise<CheckResult> {
  const startTime = Date.now()
  const base = baseUrl(config.store_url)
  const findings: Finding[] = []

  logger.debug(`Running multi-language detection check for ${base}`)

  let browser
  try {
    browser = await chromium.launch({ headless: process.env.QA_HEADLESS !== 'false' })
    const page = await browser.newPage()

    await page.goto(`${base}/`, { waitUntil: 'domcontentloaded', timeout: 15000 })

    // Check for hreflang tags
    const hreflangs = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('link[rel="alternate"][hreflang]'))
      return links.map((link: any) => ({
        hreflang: link.getAttribute('hreflang'),
        href: link.getAttribute('href'),
      }))
    })

    if (hreflangs.length > 0) {
      const languages = new Set(hreflangs.map((h) => h.hreflang?.split('-')[0]).filter(Boolean))
      findings.push({
        id: 'multi-lang-hreflang',
        severity: 'info',
        title: `Store supports ${languages.size} language(s) via hreflang`,
        description: `Detected hreflang tags for ${Array.from(languages).join(', ')}. Store is configured for multi-language SEO.`,
        evidence: hreflangs.map((h) => `${h.hreflang}: ${h.href}`),
      })
    }

    // Check for language switcher
    const hasSwitcher = await page.evaluate(() => {
      const switchers = [
        document.querySelector('[data-language-selector]'),
        document.querySelector('.language-switcher'),
        document.querySelector('[aria-label*="language" i]'),
        Array.from(document.querySelectorAll('a, button')).find((el: any) =>
          el.textContent?.toLowerCase().includes('language') || el.textContent?.toLowerCase().includes('lang'),
        ),
      ]
      return switchers.some((s) => s !== null)
    })

    if (hasSwitcher) {
      findings.push({
        id: 'multi-lang-switcher',
        severity: 'info',
        title: 'Language switcher detected',
        description: 'Store has a language/region selector visible to users.',
      })
    }

    // Check for currency variations
    const currencyInfo = await page.evaluate(() => {
      const priceElements = Array.from(document.querySelectorAll('[data-currency], .price, [class*="price"]')).slice(0, 5)
      const currencies = new Set<string>()

      priceElements.forEach((el: any) => {
        const text = el.textContent
        const currencyMatch = text?.match(/[$£€¥₹₽]/g)
        if (currencyMatch) {
          currencyMatch.forEach((c: string) => currencies.add(c))
        }
        const currencyAttr = el.getAttribute('data-currency')
        if (currencyAttr) currencies.add(currencyAttr)
      })

      return Array.from(currencies)
    })

    if (currencyInfo.length > 1) {
      findings.push({
        id: 'multi-lang-multi-currency',
        severity: 'info',
        title: `Store displays ${currencyInfo.length} currencies`,
        description: `Detected multiple currencies: ${currencyInfo.join(', ')}. Store may support international sales.`,
      })
    }

    // Check for Shopify Markets (via Admin API would be better, but this is browser-based fallback)
    const metaTags = await page.evaluate(() => {
      const tags = Array.from(document.querySelectorAll('meta'))
      return tags
        .map((tag: any) => ({
          name: tag.getAttribute('name'),
          content: tag.getAttribute('content'),
          property: tag.getAttribute('property'),
        }))
        .filter((t: any) => t.content?.toLowerCase().includes('market') || t.property?.toLowerCase().includes('market'))
    })

    if (metaTags.length > 0) {
      findings.push({
        id: 'multi-lang-markets-meta',
        severity: 'info',
        title: 'Store may use Shopify Markets',
        description: 'Detected market-related meta tags indicating Shopify Markets setup.',
      })
    }

    // Check for RTL language support
    const htmlDir = await page.evaluate(() => {
      return document.documentElement.getAttribute('dir') || 'ltr'
    })

    if (htmlDir === 'rtl') {
      findings.push({
        id: 'multi-lang-rtl',
        severity: 'info',
        title: 'Store supports RTL languages',
        description: 'HTML element has dir="rtl" attribute. Store is configured for right-to-left languages.',
      })
    }

    // Check for language path patterns (e.g., /en/, /fr/)
    const links = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('a[href]'))
        .map((a: any) => a.getAttribute('href'))
        .filter((href: any) => /^\/[a-z]{2}(\/|$)/i.test(href ?? ''))
        .slice(0, 5)
    })

    if (links.length > 0) {
      findings.push({
        id: 'multi-lang-path-patterns',
        severity: 'info',
        title: 'Language path patterns detected',
        description: `Found URL paths with language codes (e.g., /en/, /fr/). Store uses path-based localization.`,
        evidence: links,
      })
    }

    // Summary finding
    const detectionCount =
      (hreflangs.length > 0 ? 1 : 0) +
      (hasSwitcher ? 1 : 0) +
      (currencyInfo.length > 1 ? 1 : 0) +
      (metaTags.length > 0 ? 1 : 0) +
      (htmlDir === 'rtl' ? 1 : 0) +
      (links.length > 0 ? 1 : 0)

    if (detectionCount === 0) {
      findings.push({
        id: 'multi-lang-not-detected',
        severity: 'info',
        title: 'Single-language store',
        description: 'No multi-language or multi-market configuration detected. Store appears to serve a single market/language.',
      })
    } else if (detectionCount >= 3) {
      findings.push({
        id: 'multi-lang-well-configured',
        severity: 'info',
        title: `Multi-language store well configured (${detectionCount} indicators)`,
        description: `Store has strong multi-language/multi-market setup with ${detectionCount} detection indicators.`,
      })
    }

    await page.close()
  } catch (err: any) {
    findings.push({
      id: 'multi-lang-browser-error',
      severity: 'high',
      title: 'Could not run multi-language detection',
      description: `Browser automation failed: ${err.message}`,
      recommendation: 'Check Playwright installation.',
    })
  } finally {
    if (browser) await browser.close()
  }

  return {
    id: 'multi-language-detection',
    name: 'Multi-Language Detection',
    status: findings.some((f) => f.severity === 'critical') ? 'fail' : 'pass',
    duration_ms: Date.now() - startTime,
    findings,
  }
}
