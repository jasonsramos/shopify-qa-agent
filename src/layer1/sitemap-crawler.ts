import { secureFetch } from '../utils.js'
import { BrowserContext } from 'playwright'

export interface SitemapPage {
  url: string
  type: 'product' | 'collection' | 'blog' | 'page' | 'policy' | 'nav' | 'other'
  source: 'sitemap' | 'nav'
}

function extractLocs(xml: string): string[] {
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/gi)].map((m) => m[1].trim())
}

function classifyUrl(url: string): SitemapPage['type'] {
  if (url.includes('/products/')) return 'product'
  if (url.includes('/collections/')) return 'collection'
  if (url.includes('/blogs/')) return 'blog'
  if (url.includes('/pages/')) return 'page'
  if (url.includes('/policies/')) return 'policy'
  return 'other'
}

const SKIP_EXTENSIONS = /\.(pdf|zip|jpg|jpeg|png|gif|webp|svg|mp4|mp3|woff|woff2|ttf|css|js)$/i

/**
 * Crawl nav/header/footer links from the homepage DOM — mirrors real user navigation.
 * Requires an already-authenticated Playwright context (password bypass done by caller).
 */
export async function discoverNavPages(
  context: BrowserContext,
  base: string
): Promise<SitemapPage[]> {
  const page = await context.newPage()
  const hostname = new URL(base).hostname
  const found: SitemapPage[] = []

  try {
    await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 12000 }).catch(() => null)

    const links = await page.$$eval(
      'nav a[href], header a[href], footer a[href], .menu a[href], .nav a[href], #menu a[href], [class*="navigation"] a[href], [class*="site-nav"] a[href]',
      (els: Element[], origin: string) =>
        els
          .map((el) => ({
            href: (el as HTMLAnchorElement).href,
            text: el.textContent?.trim() || '',
          }))
          .filter(({ href, text }) => {
            try {
              const u = new URL(href)
              return (
                u.hostname === new URL(origin).hostname &&
                !href.includes('#') &&
                text.length >= 2 &&
                !/\.(pdf|zip|jpg|jpeg|png|gif|webp|svg|mp4|mp3|woff|css|js)$/i.test(href)
              )
            } catch {
              return false
            }
          }),
      base
    )

    const seen = new Set<string>()
    for (const { href } of links) {
      const clean = href.split('?')[0].replace(/\/$/, '') || base
      if (!seen.has(clean)) {
        seen.add(clean)
        found.push({ url: clean, type: classifyUrl(clean), source: 'nav' })
      }
    }
  } catch {
    // nav crawl failed — caller falls back to sitemap only
  } finally {
    await page.close()
  }

  return found
}

/**
 * Parse Shopify sitemap index + sub-sitemaps to get all store URLs.
 */
export async function discoverSitemapPages(base: string): Promise<SitemapPage[]> {
  let rootXml = ''
  try {
    const res = await secureFetch(`${base}/sitemap.xml`, { timeout: 12000 })
    rootXml = await res.text()
  } catch {
    return []
  }

  const isSitemapIndex = rootXml.includes('<sitemapindex')
  const hostname = new URL(base).hostname
  let allUrls: string[] = []

  if (isSitemapIndex) {
    const subUrls = extractLocs(rootXml).filter((u) => u.includes('sitemap'))
    for (const subUrl of subUrls) {
      try {
        const res = await secureFetch(subUrl, { timeout: 10000 })
        const xml = await res.text()
        allUrls.push(...extractLocs(xml))
      } catch {
        // sub-sitemap unavailable — skip
      }
    }
  } else {
    allUrls = extractLocs(rootXml)
  }

  return allUrls
    .filter((url) => url.includes(hostname) && !url.endsWith('/sitemap.xml') && !SKIP_EXTENSIONS.test(url))
    .map((url) => ({ url, type: classifyUrl(url), source: 'sitemap' as const }))
}

/**
 * Combined discovery: nav links (what users actually visit) + sitemap (products/collections/policies).
 * Nav pages are prioritised — they represent real user-reachable content.
 */
export async function discoverPages(
  base: string,
  context?: BrowserContext
): Promise<SitemapPage[]> {
  const [sitemapPages, navPages] = await Promise.all([
    discoverSitemapPages(base),
    context ? discoverNavPages(context, base) : Promise.resolve([] as SitemapPage[]),
  ])

  // Merge: nav pages first (prioritised), then sitemap pages not already covered
  const seen = new Set(navPages.map((p) => p.url))
  const merged = [
    ...navPages,
    ...sitemapPages.filter((p) => !seen.has(p.url)),
  ]

  return merged
}

const SAMPLES_PER_TYPE: Record<SitemapPage['type'], number> = {
  product: 5,
  collection: 5,
  page: 10,
  blog: 3,
  policy: 5,
  nav: 15,   // nav pages are all high-priority
  other: 2,
}

/**
 * Sample evenly across types. Nav-sourced pages are always included up to their limit.
 */
export function samplePages(pages: SitemapPage[], maxTotal = 25): SitemapPage[] {
  // Always include all nav pages first (up to their limit)
  const navPages = pages.filter((p) => p.source === 'nav').slice(0, SAMPLES_PER_TYPE.nav)
  const navUrls = new Set(navPages.map((p) => p.url))

  const byType: Partial<Record<SitemapPage['type'], SitemapPage[]>> = {}
  for (const p of pages.filter((p) => !navUrls.has(p.url))) {
    if (!byType[p.type]) byType[p.type] = []
    byType[p.type]!.push(p)
  }

  const result: SitemapPage[] = [...navPages]
  const remaining = maxTotal - result.length

  // Fill remaining slots with sitemap-sampled pages
  const sitemapSampled: SitemapPage[] = []
  for (const [type, list] of Object.entries(byType) as [SitemapPage['type'], SitemapPage[]][]) {
    const limit = SAMPLES_PER_TYPE[type] ?? 3
    const step = Math.max(1, Math.floor(list.length / limit))
    for (let i = 0; i < list.length && sitemapSampled.filter((p) => p.type === type).length < limit; i += step) {
      sitemapSampled.push(list[i])
    }
  }

  result.push(...sitemapSampled.slice(0, remaining))
  return result.slice(0, maxTotal)
}
