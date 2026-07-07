import { SiteConfig, CheckResult, Finding } from '../../types.js'
import { baseUrl, logger } from '../../utils.js'
import { BrowserSession } from '../browser-session.js'

/**
 * Template & UI health check.
 *
 * Catches rendered-output template bugs that other checks miss because the page
 * still "looks fine":
 *  1. Literal `{width}` (unrendered Liquid image_url token) in image URLs —
 *     ships full-resolution originals with no srcset. Root cause of oversized
 *     image findings.
 *  2. Heading outline problems on RENDERED pages: zero or multiple <h1>, and
 *     the same heading text duplicated many times (carousel/marquee clones
 *     emitted as real headings — wrecks SEO outline and screen-reader nav).
 */
export async function runTemplateUiHealthCheck(
  config: SiteConfig,
  sharedSession?: BrowserSession
): Promise<CheckResult> {
  const startTime = Date.now()
  const base = baseUrl(config.store_url)
  const findings: Finding[] = []

  logger.debug(`Running template/UI health check for ${base}`)

  let owned = false
  let session: BrowserSession | null = null
  try {
    ;({ session, owned } = await BrowserSession.acquire(config, sharedSession))

    const pages = ['/', '/products', '/cart']
    const placeholderHits: { page: string; src: string }[] = []
    const headingIssues: string[] = []

    for (const pagePath of pages) {
      const page = await session.newPage()
      try {
        await page.goto(`${base}${pagePath}`, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => null)
        // Scroll once so lazy-loaded imgs resolve their real src
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight / 2)).catch(() => null)
        await page.waitForTimeout(800)

        const scan = await page
          .evaluate(() => {
            // 1. Unrendered template tokens in image URLs ({width}, {height}, etc.)
            const tokenRe = /\{(width|height|size|crop)\}/
            const badSrcs = Array.from(document.images)
              .map((i) => i.currentSrc || i.src || '')
              .filter((s) => tokenRe.test(s))
            // srcset attributes too
            for (const img of Array.from(document.querySelectorAll('img[srcset], source[srcset]'))) {
              const ss = img.getAttribute('srcset') || ''
              if (tokenRe.test(ss)) badSrcs.push(`srcset: ${ss.slice(0, 120)}`)
            }

            // 2. Heading outline
            const h1s = Array.from(document.querySelectorAll('h1')).map((h) => (h.textContent || '').trim())
            const allHeadings = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6')).map((h) =>
              (h.textContent || '').trim()
            )
            const counts = new Map<string, number>()
            for (const t of allHeadings) {
              if (t.length < 3) continue
              counts.set(t, (counts.get(t) || 0) + 1)
            }
            const duplicated = [...counts.entries()]
              .filter(([, n]) => n >= 4)
              .map(([text, n]) => ({ text: text.slice(0, 60), count: n }))

            return { badSrcs: [...new Set(badSrcs)].slice(0, 15), h1s, totalHeadings: allHeadings.length, duplicated }
          })
          .catch(() => null)

        if (!scan) continue

        for (const src of scan.badSrcs) placeholderHits.push({ page: pagePath, src })

        if (scan.h1s.length === 0) {
          headingIssues.push(`${pagePath}: no <h1> heading`)
        } else if (scan.h1s.length > 1) {
          headingIssues.push(
            `${pagePath}: ${scan.h1s.length} <h1> headings ("${scan.h1s.map((t) => t.slice(0, 40)).join('" / "')}") — keep exactly one`
          )
        }
        for (const d of scan.duplicated) {
          headingIssues.push(
            `${pagePath}: heading "${d.text}" repeated ${d.count}× — likely carousel/marquee clones emitted as real headings; render clones as <span aria-hidden="true">`
          )
        }
      } finally {
        await page.close().catch(() => null)
      }
    }

    if (placeholderHits.length > 0) {
      const sample = placeholderHits.slice(0, 5).map((h) => `• ${h.page}: ${h.src}`).join('\n')
      findings.push({
        id: 'template-unrendered-width-token',
        severity: 'high',
        title: `Unrendered {width} token in ${placeholderHits.length} image URL(s) — theme template bug`,
        description: `Image URLs contain the literal Liquid placeholder (e.g. ?width={width}) instead of a real size. Shopify's CDN then serves the FULL-RESOLUTION original with no responsive srcset — this is a template bug and a primary cause of oversized-image/performance findings.\n${sample}${placeholderHits.length > 5 ? `\n…and ${placeholderHits.length - 5} more.` : ''}`,
        recommendation:
          "In the theme Liquid, pass an integer width to image_url (e.g. image_url: width: 400) or use image_tag with widths: '200,400,800' to generate a real srcset. Search the theme for 'width={width}' to find the offending snippet/section.",
        evidence: `${placeholderHits.length} image URL(s) across ${new Set(placeholderHits.map((h) => h.page)).size} page(s)`,
      })
    }

    if (headingIssues.length > 0) {
      const hasDupSpam = headingIssues.some((i) => i.includes('repeated'))
      findings.push({
        id: 'heading-outline-issues',
        severity: hasDupSpam ? 'medium' : 'low',
        title: `Heading outline issues on ${new Set(headingIssues.map((i) => i.split(':')[0])).size} page(s)`,
        description: headingIssues.map((i) => `• ${i}`).join('\n'),
        recommendation:
          'Keep exactly one <h1> per page. For duplicated marquee/carousel headings, render the visual clones as plain <span> elements with aria-hidden="true" so only one semantic heading remains.',
        evidence: `${headingIssues.length} issue(s)`,
      })
    }

    if (findings.length === 0) {
      findings.push({
        id: 'template-ui-health-pass',
        severity: 'info',
        title: 'Template output healthy',
        description: 'No unrendered template tokens in image URLs; heading outline is clean on scanned pages.',
      })
    }
  } catch (err: any) {
    logger.debug(`Template/UI health check error: ${err.message}`)
    findings.push({
      id: 'template-ui-health-error',
      severity: 'info',
      title: 'Template/UI health check could not run',
      description: `Browser error: ${err.message}`,
    })
  } finally {
    if (owned && session) await session.close()
  }

  return {
    id: 'template-ui-health',
    name: 'Template & UI Health',
    status: findings.some((f) => f.severity === 'critical' || f.severity === 'high')
      ? 'warning'
      : 'pass',
    duration_ms: Date.now() - startTime,
    findings,
  }
}
