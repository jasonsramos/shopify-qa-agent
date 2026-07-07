import { SiteConfig, CheckResult, Finding } from '../../types.js'
import { secureFetch, baseUrl, logger } from '../../utils.js'
import { BrowserSession } from '../browser-session.js'
import { discoverPages, samplePages } from '../sitemap-crawler.js'

const MAX_PAGES = 8
const MAX_IMAGE_HEAD_CHECKS = 40
const LARGE_IMAGE_BYTES = 500 * 1024
const HUGE_IMAGE_BYTES = 1024 * 1024

export async function runImageAuditCheck(config: SiteConfig, sharedSession?: BrowserSession): Promise<CheckResult> {
  const startTime = Date.now()
  const findings: Finding[] = []
  const base = baseUrl(config.store_url)

  logger.debug('Running image audit check')

  let owned = false
  let session: BrowserSession | null = null

  try {
    ;({ session, owned } = await BrowserSession.acquire(config, sharedSession))
    const context = session.getContext()

    // Discover a small representative page set (homepage always first)
    const discovered = await discoverPages(base, context ?? undefined)
    const sampled = samplePages(discovered, MAX_PAGES)
    const pageUrls = Array.from(new Set([base + '/', ...sampled.map((p) => p.url)])).slice(0, MAX_PAGES)

    let totalImages = 0
    let missingAlt = 0
    let missingDimensions = 0
    let missingLazy = 0
    let cdnNoWebp = 0
    let missingSrcset = 0
    const pagesScanned: string[] = []
    const imageUrls = new Set<string>()

    for (const url of pageUrls) {
      let html = ''
      try {
        const page = await session.newPage()
        try {
          const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 12000 })
          if (!resp || resp.status() >= 400) continue
          html = await page.content()
        } finally {
          await page.close().catch(() => null)
        }
      } catch {
        continue
      }

      const images = html.match(/<img[^>]*>/gi) || []
      if (images.length === 0) continue
      pagesScanned.push(url)
      totalImages += images.length

      for (const img of images) {
        if (!/alt\s*=/.test(img) || /alt\s*=\s*["']\s*["']/.test(img)) missingAlt++
        if (!/width\s*=/.test(img) || !/height\s*=/.test(img)) missingDimensions++
        if (!/loading\s*=\s*["']lazy["']/.test(img)) missingLazy++
        if (!/srcset\s*=/.test(img)) missingSrcset++

        const src = img.match(/\bsrc\s*=\s*["']([^"']+)["']/)?.[1]
        if (src) {
          const isCdn = /cdn\.shopify\.com|images\.unsplash\.com|images\.pexels\.com/.test(src)
          if (isCdn && !/format=webp|format%3Dwebp/.test(src)) cdnNoWebp++
          try {
            imageUrls.add(new URL(src, url).href)
          } catch {
            /* skip */
          }
        }
      }
    }

    if (totalImages === 0) {
      findings.push({
        id: 'no-images',
        severity: 'info',
        title: 'No images found',
        description: `Scanned ${pageUrls.length} page(s); no <img> tags detected.`,
      })
      return { id: 'image-audit', name: 'Image Audit', status: 'pass', duration_ms: Date.now() - startTime, findings }
    }

    // Measure real byte sizes for a sample of images (HEAD → content-length)
    const sampleUrls = [...imageUrls].slice(0, MAX_IMAGE_HEAD_CHECKS)
    const sizes = await Promise.all(
      sampleUrls.map(async (u) => {
        try {
          const res = await secureFetch(u, { method: 'HEAD', timeout: 6000 }).catch(() => null)
          const len = res?.headers.get('content-length')
          return { url: u, bytes: len ? parseInt(len, 10) : 0 }
        } catch {
          return { url: u, bytes: 0 }
        }
      })
    )
    const large = sizes.filter((s) => s.bytes >= LARGE_IMAGE_BYTES)
    const huge = sizes.filter((s) => s.bytes >= HUGE_IMAGE_BYTES)

    // ── Findings ──────────────────────────────────────────────────────────
    if (huge.length > 0) {
      findings.push({
        id: 'oversized-images-huge',
        severity: 'high',
        title: `${huge.length} image(s) over 1 MB`,
        description: `Images over 1 MB dramatically slow page load, especially on mobile. Largest sampled: ${Math.round(Math.max(...huge.map((h) => h.bytes)) / 1024)} KB. Example: ${huge[0].url}`,
        recommendation: 'Compress and resize images; serve WebP/AVIF at appropriate dimensions.',
        evidence: huge.slice(0, 5).map((h) => `${Math.round(h.bytes / 1024)}KB ${h.url}`),
      })
    }
    const largeOnly = large.filter((l) => l.bytes < HUGE_IMAGE_BYTES)
    if (largeOnly.length > 0) {
      findings.push({
        id: 'oversized-images',
        severity: 'medium',
        title: `${largeOnly.length} image(s) between 500 KB and 1 MB`,
        description: `Large images increase page weight and LCP. Sampled ${sampleUrls.length} of ${imageUrls.size} unique images.`,
        recommendation: 'Target < 200 KB per image; compress and use responsive sizes.',
        evidence: largeOnly.slice(0, 5).map((l) => `${Math.round(l.bytes / 1024)}KB ${l.url}`),
      })
    }

    if (missingAlt > 0) {
      findings.push({
        id: 'missing-alt-text',
        severity: 'high',
        title: `${missingAlt}/${totalImages} images missing alt text`,
        description: `Across ${pagesScanned.length} page(s), ${missingAlt} images have no alt attribute. This breaks screen readers and harms SEO.`,
        recommendation: 'Add descriptive alt text to every content image (empty alt="" only for decorative).',
        evidence: `${missingAlt} images`,
      })
    }
    if (missingDimensions > 0) {
      findings.push({
        id: 'missing-dimensions',
        severity: 'medium',
        title: `${missingDimensions}/${totalImages} images missing width/height`,
        description: `${missingDimensions} images lack explicit width/height, causing Cumulative Layout Shift (CLS).`,
        recommendation: 'Add width and height attributes to reserve layout space.',
        evidence: `${missingDimensions} images`,
      })
    }
    if (missingLazy > 0) {
      findings.push({
        id: 'missing-lazy-loading',
        severity: 'low',
        title: `${missingLazy}/${totalImages} images missing loading="lazy"`,
        description: `${missingLazy} images load eagerly. Lazy-loading offscreen images saves bandwidth and speeds first paint.`,
        recommendation: 'Add loading="lazy" to below-the-fold images (keep the LCP/hero image eager).',
        evidence: `${missingLazy} images`,
      })
    }
    if (missingSrcset > 0) {
      findings.push({
        id: 'missing-srcset',
        severity: 'low',
        title: `${missingSrcset}/${totalImages} images without responsive srcset`,
        description: `${missingSrcset} images serve a single resolution to all devices, wasting mobile bandwidth.`,
        recommendation: 'Use srcset/sizes (or Shopify image_url with multiple widths) for responsive images.',
        evidence: `${missingSrcset} images`,
      })
    }
    if (cdnNoWebp > 0) {
      findings.push({
        id: 'cdn-missing-webp',
        severity: 'low',
        title: `${cdnNoWebp} CDN images not served as WebP`,
        description: `${cdnNoWebp} Shopify/CDN images lack a WebP format param. WebP is ~25–35% smaller than JPEG.`,
        recommendation: 'Use {{ image | image_url: width: 800, format: "webp" }} in Liquid.',
        evidence: `${cdnNoWebp} images`,
      })
    }

    if (findings.length === 0) {
      findings.push({
        id: 'images-optimized',
        severity: 'info',
        title: `Image optimization good (${totalImages} images across ${pagesScanned.length} pages)`,
        description: 'Images have alt text, dimensions, lazy loading, responsive srcset, and reasonable file sizes.',
      })
    } else {
      findings.unshift({
        id: 'image-audit-summary',
        severity: 'info',
        title: `Audited ${totalImages} images across ${pagesScanned.length} page(s)`,
        description: `Measured real byte sizes for ${sampleUrls.length} of ${imageUrls.size} unique images.`,
      })
    }

    return {
      id: 'image-audit',
      name: 'Image Audit',
      status: findings.some((f) => f.severity === 'high' || f.severity === 'critical') ? 'warning' : 'pass',
      duration_ms: Date.now() - startTime,
      findings,
    }
  } catch (err: any) {
    logger.debug(`Image audit error: ${err.message}`)
    findings.push({
      id: 'image-audit-error',
      severity: 'medium',
      title: 'Image audit failed',
      description: `Could not fetch and analyze images: ${err.message}`,
      recommendation: 'Verify store is accessible.',
    })
    return { id: 'image-audit', name: 'Image Audit', status: 'warning', duration_ms: Date.now() - startTime, findings }
  } finally {
    if (owned && session) await session.close()
  }
}
