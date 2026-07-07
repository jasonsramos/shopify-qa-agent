import { SiteConfig, CheckResult, Finding } from '../../types.js'
import { baseUrl, logger } from '../../utils.js'
import { BrowserSession } from '../browser-session.js'
import { discoverPages, samplePages, SitemapPage } from '../sitemap-crawler.js'

interface PageData {
  url: string
  type: SitemapPage['type']
  status: number
  title: string
  metaDesc: string
  formCount: number
  unlabeledInputs: number
  imagesWithoutAlt: number
  imageCount: number
  consoleErrors: string[]
  h1Count: number
  ogImage: boolean
  loadedOk: boolean
}

export async function runSiteWideScanCheck(
  config: SiteConfig,
  sharedSession?: BrowserSession
): Promise<CheckResult> {
  const startTime = Date.now()
  const findings: Finding[] = []
  const base = baseUrl(config.store_url)

  // Step 1: Acquire the shared browser session (or launch our own)
  let owned = false
  let session: BrowserSession
  try {
    ;({ session, owned } = await BrowserSession.acquire(config, sharedSession))
  } catch (err: any) {
    findings.push({
      id: 'sitewide-browser-error',
      severity: 'high',
      title: 'Could not launch browser for site-wide scan',
      description: err.message,
    })
    return { id: 'site-wide-scan', name: 'Site-Wide Scan', status: 'fail', duration_ms: Date.now() - startTime, findings }
  }

  const context = session.getContext()

  // Step 2: Discover pages — nav crawl (DOM) + sitemap (products/collections/policies)
  logger.debug('Discovering pages via nav crawl + sitemap…')
  const allPages = await discoverPages(base, context ?? undefined)
  const sampled = samplePages(allPages, 25)

  if (allPages.length === 0) {
    if (owned) await session.close()
    findings.push({
      id: 'sitewide-no-sitemap',
      severity: 'medium',
      title: 'Sitemap not found — discovered pages via navigation only',
      description: 'Could not read /sitemap.xml. Continuing with nav-crawled pages only.',
      recommendation: 'Shopify auto-generates sitemap.xml. Check Online Store → Preferences.',
    })
    // If nav crawl also found nothing, bail
    if (sampled.length === 0) {
      return { id: 'site-wide-scan', name: 'Site-Wide Scan', status: 'warning', duration_ms: Date.now() - startTime, findings }
    }
  }

  const typeCounts: Record<string, number> = {}
  for (const p of allPages) typeCounts[p.type] = (typeCounts[p.type] || 0) + 1

  logger.debug(
    `Discovered ${allPages.length} pages (${Object.entries(typeCounts)
      .map(([t, n]) => `${n} ${t}s`)
      .join(', ')}). Scanning sample of ${sampled.length}…`
  )

  // Step 3: Scan sampled pages (reuse the same browser context — already authenticated)
  const scanned: PageData[] = []

  try {
    for (const { url, type } of sampled) {
      const page = await session.newPage()
      const consoleErrors: string[] = []

      page.on('console', (msg) => {
        if (msg.type() === 'error') consoleErrors.push(msg.text().slice(0, 120))
      })

      let data: PageData = {
        url, type, status: 0, title: '', metaDesc: '', formCount: 0,
        unlabeledInputs: 0, imagesWithoutAlt: 0, imageCount: 0,
        consoleErrors: [], h1Count: 0, ogImage: false, loadedOk: false,
      }

      try {
        const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 12000 })
        data.status = response?.status() ?? 0
        data.loadedOk = data.status === 200

        if (data.loadedOk) {
          const extracted = await page.evaluate(() => {
            const inputs = Array.from(
              document.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"])')
            )
            const unlabeled = inputs.filter((input) => {
              const id = input.getAttribute('id')
              if (id && document.querySelector(`label[for="${id}"]`)) return false
              if (input.closest('label')) return false
              if (input.getAttribute('aria-label') || input.getAttribute('aria-labelledby')) return false
              return true
            })
            const imgs = Array.from(document.querySelectorAll('img'))
            return {
              title: document.title || '',
              metaDesc: document.querySelector('meta[name="description"]')?.getAttribute('content') || '',
              formCount: document.querySelectorAll('form').length,
              unlabeledInputs: unlabeled.length,
              imageCount: imgs.length,
              imagesWithoutAlt: imgs.filter((i) => !i.getAttribute('alt') || i.getAttribute('alt') === '').length,
              h1Count: document.querySelectorAll('h1').length,
              ogImage: !!document.querySelector('meta[property="og:image"]'),
            }
          })
          Object.assign(data, extracted)
        }
      } catch {
        // page failed to load — status stays 0
      } finally {
        data.consoleErrors = consoleErrors.slice(0, 3)
        scanned.push(data)
        await page.close()
      }
    }
  } finally {
    if (owned) await session.close()
  }

  // Step 4: Aggregate findings

  const loadFailed = scanned.filter((p) => !p.loadedOk && p.status !== 0)
  const notFound = scanned.filter((p) => p.status === 404)
  const missingTitle = scanned.filter((p) => p.loadedOk && !p.title.trim())
  const missingMeta = scanned.filter((p) => p.loadedOk && !p.metaDesc.trim())
  const missingOgImage = scanned.filter((p) => p.loadedOk && !p.ogImage)
  const unlabeledForms = scanned.filter((p) => p.loadedOk && p.unlabeledInputs > 0)
  const altTextIssues = scanned.filter((p) => p.loadedOk && p.imagesWithoutAlt > 0)
  const consoleErrorPages = scanned.filter((p) => p.loadedOk && p.consoleErrors.length > 0)
  const multipleH1 = scanned.filter((p) => p.loadedOk && p.h1Count > 1)
  const noH1 = scanned.filter((p) => p.loadedOk && p.h1Count === 0)

  if (notFound.length > 0) {
    findings.push({
      id: 'sitewide-404-pages',
      severity: 'high',
      title: `${notFound.length} page(s) in sitemap return 404`,
      description: `Pages in your sitemap that are missing: ${notFound.map((p) => p.url).join(', ')}`,
      recommendation: 'Remove deleted pages from sitemap or redirect them.',
    })
  }

  if (loadFailed.length > 0) {
    findings.push({
      id: 'sitewide-load-failures',
      severity: 'medium',
      title: `${loadFailed.length} page(s) failed to load (non-404 errors)`,
      description: `Pages with unexpected status codes: ${loadFailed.map((p) => `${p.url} (${p.status})`).join(', ')}`,
    })
  }

  if (missingTitle.length > 0) {
    findings.push({
      id: 'sitewide-missing-title',
      severity: 'high',
      title: `${missingTitle.length}/${scanned.length} scanned pages missing <title>`,
      description: `Pages without a title tag: ${missingTitle.map((p) => p.url).slice(0, 5).join(', ')}${missingTitle.length > 5 ? '…' : ''}`,
      recommendation: 'Every page must have a unique, descriptive <title>.',
    })
  }

  if (missingMeta.length > 0) {
    const severity = missingMeta.length > scanned.length * 0.5 ? 'high' : 'medium'
    findings.push({
      id: 'sitewide-missing-meta-desc',
      severity,
      title: `${missingMeta.length}/${scanned.length} scanned pages missing meta description`,
      description: `Pages without meta description: ${missingMeta.map((p) => p.url).slice(0, 5).join(', ')}${missingMeta.length > 5 ? '…' : ''}`,
      recommendation: 'Add unique meta descriptions (150-160 chars) to all pages.',
    })
  }

  if (missingOgImage.length > scanned.length * 0.5) {
    findings.push({
      id: 'sitewide-missing-og-image',
      severity: 'low',
      title: `${missingOgImage.length}/${scanned.length} pages missing og:image`,
      description: 'Social sharing will show no preview image for these pages.',
      recommendation: 'Add og:image meta tag to all key pages.',
    })
  }

  if (unlabeledForms.length > 0) {
    const totalUnlabeled = unlabeledForms.reduce((s, p) => s + p.unlabeledInputs, 0)
    findings.push({
      id: 'sitewide-unlabeled-inputs',
      severity: 'high',
      title: `${totalUnlabeled} unlabeled form inputs across ${unlabeledForms.length} page(s)`,
      description: `Pages with unlabeled inputs: ${unlabeledForms.map((p) => p.url).slice(0, 5).join(', ')}${unlabeledForms.length > 5 ? '…' : ''}`,
      recommendation: 'Add <label for=""> or aria-label to every form input.',
    })
  }

  if (altTextIssues.length > 0) {
    const totalMissing = altTextIssues.reduce((s, p) => s + p.imagesWithoutAlt, 0)
    findings.push({
      id: 'sitewide-missing-alt',
      severity: 'medium',
      title: `${totalMissing} images missing alt text across ${altTextIssues.length} page(s)`,
      description: `Pages with alt text issues: ${altTextIssues.map((p) => `${p.url} (${p.imagesWithoutAlt} imgs)`).slice(0, 5).join(', ')}`,
      recommendation: 'Add descriptive alt text to all images for screen readers and SEO.',
    })
  }

  if (consoleErrorPages.length > 0) {
    findings.push({
      id: 'sitewide-console-errors',
      severity: 'medium',
      title: `JavaScript errors on ${consoleErrorPages.length} page(s)`,
      description: `Pages with JS console errors: ${consoleErrorPages.map((p) => p.url).slice(0, 5).join(', ')}. Example error: ${consoleErrorPages[0].consoleErrors[0] || 'unknown'}`,
      recommendation: 'Open DevTools on these pages and resolve JavaScript errors.',
    })
  }

  if (multipleH1.length > 0) {
    findings.push({
      id: 'sitewide-multiple-h1',
      severity: 'low',
      title: `${multipleH1.length} page(s) have multiple H1 headings`,
      description: `Pages: ${multipleH1.map((p) => p.url).slice(0, 5).join(', ')}`,
      recommendation: 'Use exactly one H1 per page.',
    })
  }

  if (noH1.length > 0) {
    findings.push({
      id: 'sitewide-no-h1',
      severity: 'medium',
      title: `${noH1.length} page(s) missing H1 heading`,
      description: `Pages without H1: ${noH1.map((p) => p.url).slice(0, 5).join(', ')}`,
      recommendation: 'Add a descriptive H1 to every page.',
    })
  }

  if (findings.length === 0) {
    findings.push({
      id: 'sitewide-pass',
      severity: 'info',
      title: `Site-wide scan passed (${scanned.length} pages checked)`,
      description: `Scanned ${scanned.length} pages sampled from ${allPages.length} total. No issues found across forms, SEO, images, or headings.`,
    })
  } else {
    // Add summary finding at the top
    findings.unshift({
      id: 'sitewide-summary',
      severity: 'info',
      title: `Scanned ${scanned.length} pages from ${allPages.length} total discovered (${Object.entries(typeCounts).map(([t, n]) => `${n} ${t}s`).join(', ')})`,
      description: `Pages sampled: ${sampled.map((p) => p.url).join(', ')}`,
    })
  }

  const hasHigh = findings.some((f) => f.severity === 'high' || f.severity === 'critical')
  const hasMedium = findings.some((f) => f.severity === 'medium')

  return {
    id: 'site-wide-scan',
    name: 'Site-Wide Scan',
    status: hasHigh ? 'warning' : hasMedium ? 'warning' : 'pass',
    duration_ms: Date.now() - startTime,
    findings,
  }
}
