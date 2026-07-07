import { SiteConfig, PerformanceResult, Finding } from '../../types.js'
import { secureFetch, baseUrl, logger } from '../../utils.js'
import { BrowserSession } from '../browser-session.js'

const PAGESPEED_API = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed'

interface PageSpeedResult {
  performance: number
  accessibility: number
  best_practices: number
  seo: number
  fcp_ms: number
  lcp_ms: number
  cls: number
  fid_ms: number
  tbt_ms: number
  speed_index_ms: number
  opportunities: Array<{ title: string; savings_ms: number }>
}

async function fetchPageSpeed(url: string, strategy: 'mobile' | 'desktop', apiKey?: string): Promise<PageSpeedResult | null> {
  try {
    const params = new URLSearchParams({ url, strategy })
    if (apiKey) params.set('key', apiKey)

    const response = await secureFetch(`${PAGESPEED_API}?${params}`, { timeout: 30000 })
    if (!response.ok) return null

    const data = await response.json() as any
    const cats = data.lighthouseResult?.categories || {}
    const audits = data.lighthouseResult?.audits || {}

    const opportunities = Object.values(audits)
      .filter((a: any) => a.details?.type === 'opportunity' && a.numericValue > 500)
      .map((a: any) => ({ title: a.title, savings_ms: Math.round(a.numericValue) }))
      .slice(0, 5)

    return {
      performance:   Math.round((cats.performance?.score   ?? 0) * 100),
      accessibility: Math.round((cats.accessibility?.score ?? 0) * 100),
      best_practices:Math.round((cats['best-practices']?.score ?? 0) * 100),
      seo:           Math.round((cats.seo?.score           ?? 0) * 100),
      fcp_ms:        Math.round(audits['first-contentful-paint']?.numericValue ?? 0),
      lcp_ms:        Math.round(audits['largest-contentful-paint']?.numericValue ?? 0),
      cls:           parseFloat((audits['cumulative-layout-shift']?.numericValue ?? 0).toFixed(3)),
      fid_ms:        Math.round(audits['max-potential-fid']?.numericValue ?? 0),
      tbt_ms:        Math.round(audits['total-blocking-time']?.numericValue ?? 0),
      speed_index_ms:Math.round(audits['speed-index']?.numericValue ?? 0),
      opportunities,
    }
  } catch (err: any) {
    logger.debug(`PageSpeed API error (${strategy}): ${err.message}`)
    return null
  }
}

async function runBrowserPerformanceCheck(
  base: string,
  config: SiteConfig,
  findings: Finding[],
  sharedSession?: BrowserSession
): Promise<void> {
  let owned = false
  let session: BrowserSession | null = null
  try {
    ;({ session, owned } = await BrowserSession.acquire(config, sharedSession))
    const page = await session.newPage()

    try {
      const navResp = await page.goto(base, { waitUntil: 'load', timeout: 20000 }).catch(() => null)
      await page.waitForTimeout(500)

      // Compression on the main document (Playwright exposes raw headers)
      const docHeaders = navResp ? navResp.headers() : {}
      const encoding = (docHeaders['content-encoding'] || '').toLowerCase()
      if (navResp && !encoding) {
        findings.push({
          id: 'perf-no-compression',
          severity: 'medium',
          title: 'HTML document served without compression',
          description: 'The main document response has no content-encoding (gzip/br). Compression typically cuts HTML transfer size by 60–80%.',
          recommendation: 'Enable gzip or Brotli compression (Shopify does this automatically; a missing header may indicate a proxy/CDN misconfiguration).',
        })
      }

      // NOTE: passed as a STRING, not a function — tsx/esbuild's keepNames
      // injects `__name(...)` helpers into serialized functions, which throws
      // "ReferenceError: __name is not defined" inside the browser.
      const metrics: any = await page.evaluate(`(() => {
        const nav = performance.getEntriesByType('navigation')[0]
        const paint = performance.getEntriesByType('paint')
        const fcpEntry = paint.find((e) => e.name === 'first-contentful-paint')
        const fcp = fcpEntry ? fcpEntry.startTime : 0
        const resources = performance.getEntriesByType('resource')
        const totalBytes = resources.reduce((s, r) => s + (r.transferSize || 0), 0)

        // Per-resource-type weight breakdown
        const byType = {}
        const bucket = (r) => {
          const t = r.initiatorType
          const url = r.name.split('?')[0]
          if (t === 'css' || /\\.css$/i.test(url)) return 'css'
          if (t === 'script' || /\\.m?js$/i.test(url)) return 'js'
          if (t === 'img' || /\\.(png|jpe?g|gif|webp|avif|svg)$/i.test(url)) return 'image'
          if (/\\.(woff2?|ttf|otf|eot)$/i.test(url)) return 'font'
          return 'other'
        }
        for (const r of resources) {
          const b = bucket(r)
          if (!byType[b]) byType[b] = { count: 0, kb: 0 }
          byType[b].count++
          byType[b].kb += Math.round((r.transferSize || 0) / 1024)
        }

        // Render-blocking: head scripts without async/defer + stylesheet links
        const headScripts = Array.from(document.head.querySelectorAll('script[src]')).filter(
          (s) => !s.hasAttribute('async') && !s.hasAttribute('defer')
        ).length
        const headStyles = document.head.querySelectorAll('link[rel="stylesheet"]').length

        // Sample a JS and CSS asset URL for cache-header inspection
        const firstOf = (re) => resources.map((r) => r.name).find((u) => re.test(u.split('?')[0]))
        const sampleAssets = [firstOf(/\\.m?js$/i), firstOf(/\\.css$/i)].filter(Boolean)

        return {
          ttfb: Math.round(nav ? nav.responseStart : 0),
          domInteractive: Math.round(nav ? nav.domInteractive : 0),
          loadComplete: Math.round(nav ? nav.loadEventEnd : 0),
          fcp: Math.round(fcp),
          resourceCount: resources.length,
          totalKB: Math.round(totalBytes / 1024),
          byType,
          renderBlocking: headScripts + headStyles,
          renderBlockingScripts: headScripts,
          renderBlockingStyles: headStyles,
          sampleAssets,
        }
      })()`)

      logger.debug(`Browser metrics: TTFB=${metrics.ttfb}ms FCP=${metrics.fcp}ms Load=${metrics.loadComplete}ms Resources=${metrics.resourceCount} Size=${metrics.totalKB}KB`)

      // Per-type weight breakdown (informational + flag heavy JS/images)
      const bt = metrics.byType || {}
      const fmtBreakdown = Object.entries(bt)
        .map(([t, v]: [string, any]) => `${t}: ${v.count} files / ${v.kb}KB`)
        .join(', ')
      findings.push({
        id: 'perf-weight-breakdown',
        severity: 'info',
        title: `Page weight breakdown: ${metrics.totalKB}KB across ${metrics.resourceCount} requests`,
        description: fmtBreakdown || 'No resource timing available.',
      })
      if ((bt.js?.kb ?? 0) > 1500) {
        findings.push({
          id: 'perf-heavy-js',
          severity: 'medium',
          title: `Heavy JavaScript payload: ${bt.js.kb}KB across ${bt.js.count} files`,
          description: `JavaScript is the most expensive resource type to parse/execute. ${bt.js.kb}KB is well above the ~500KB budget for fast mobile loads.`,
          recommendation: 'Code-split, defer non-critical JS, remove unused app scripts.',
        })
      }
      if ((bt.image?.kb ?? 0) > 3000) {
        findings.push({
          id: 'perf-heavy-images',
          severity: 'medium',
          title: `Heavy image payload: ${bt.image.kb}KB across ${bt.image.count} images`,
          description: `Images account for ${bt.image.kb}KB on first load. See the Image Audit for oversized files.`,
          recommendation: 'Compress, resize, serve WebP/AVIF, and lazy-load below-the-fold images.',
        })
      }

      // Render-blocking resources
      if (metrics.renderBlocking > 3) {
        findings.push({
          id: 'perf-render-blocking',
          severity: 'medium',
          title: `${metrics.renderBlocking} render-blocking resources in <head>`,
          description: `${metrics.renderBlockingScripts} synchronous script(s) and ${metrics.renderBlockingStyles} stylesheet(s) in <head> block first paint.`,
          recommendation: 'Add async/defer to scripts; inline critical CSS and load the rest asynchronously.',
        })
      }

      // Cache headers on static assets
      const sampleAssets: string[] = metrics.sampleAssets || []
      if (sampleAssets.length > 0) {
        const cacheResults = await Promise.all(
          sampleAssets.map(async (u) => {
            try {
              const res = await secureFetch(u, { method: 'HEAD', timeout: 6000 }).catch(() => null)
              const cc = res?.headers.get('cache-control') || ''
              const maxAge = parseInt(cc.match(/max-age=(\d+)/)?.[1] || '0', 10)
              return { url: u, cc, maxAge }
            } catch {
              return { url: u, cc: '', maxAge: 0 }
            }
          })
        )
        const poorlyCached = cacheResults.filter((r) => r.maxAge < 86400 && !r.cc.includes('immutable'))
        if (poorlyCached.length > 0) {
          findings.push({
            id: 'perf-weak-cache-headers',
            severity: 'low',
            title: `${poorlyCached.length} static asset(s) with weak cache headers`,
            description: `Static assets should be cached for a long time (max-age ≥ 1 day, ideally immutable). Weakly-cached: ${poorlyCached.map((r) => r.url.split('/').pop()).join(', ')}.`,
            recommendation: 'Serve versioned static assets with long max-age + immutable. Shopify CDN assets get this automatically.',
          })
        }
      }

      if (metrics.fcp > 3000) {
        findings.push({
          id: 'perf-fcp-slow',
          severity: metrics.fcp > 5000 ? 'high' : 'medium',
          title: `First Contentful Paint slow: ${(metrics.fcp / 1000).toFixed(1)}s (target: <1.8s)`,
          description: `FCP of ${(metrics.fcp / 1000).toFixed(1)}s means users wait a long time before seeing any content. Google's threshold is 1.8s (good) / 3s (needs improvement).`,
          recommendation: 'Reduce render-blocking resources, optimise server response, use a CDN.',
        })
      }

      if (metrics.ttfb > 800) {
        findings.push({
          id: 'perf-ttfb-slow',
          severity: metrics.ttfb > 2000 ? 'high' : 'medium',
          title: `Time to First Byte slow: ${metrics.ttfb}ms (target: <800ms)`,
          description: `Server responded in ${metrics.ttfb}ms. High TTFB typically indicates slow server-side rendering, database queries, or app overhead.`,
          recommendation: 'Enable Shopify CDN, reduce app processing time, check for slow app integrations.',
        })
      }

      if (metrics.loadComplete > 8000) {
        findings.push({
          id: 'perf-load-slow',
          severity: 'medium',
          title: `Page fully loaded in ${(metrics.loadComplete / 1000).toFixed(1)}s`,
          description: `Total page load time is ${(metrics.loadComplete / 1000).toFixed(1)}s. This includes all images, CSS, and scripts.`,
          recommendation: 'Lazy-load images, defer non-critical scripts, compress assets.',
        })
      }

      if (metrics.totalKB > 5000) {
        findings.push({
          id: 'perf-page-weight',
          severity: 'medium',
          title: `Page weight is large: ${metrics.totalKB}KB across ${metrics.resourceCount} resources`,
          description: `Total transferred bytes: ${metrics.totalKB}KB from ${metrics.resourceCount} network requests. Heavy pages load slower on mobile.`,
          recommendation: 'Compress images (use WebP), remove unused CSS/JS, reduce third-party scripts.',
        })
      }

      if (findings.filter((f) => ['perf-fcp-slow', 'perf-ttfb-slow', 'perf-load-slow', 'perf-page-weight'].includes(f.id)).length === 0) {
        findings.push({
          id: 'perf-browser-good',
          severity: 'info',
          title: `Performance looks good (FCP: ${(metrics.fcp / 1000).toFixed(1)}s, TTFB: ${metrics.ttfb}ms, Load: ${(metrics.loadComplete / 1000).toFixed(1)}s)`,
          description: `Browser-measured metrics — FCP: ${(metrics.fcp / 1000).toFixed(1)}s, TTFB: ${metrics.ttfb}ms, full load: ${(metrics.loadComplete / 1000).toFixed(1)}s, page weight: ${metrics.totalKB}KB. Add PAGESPEED_API_KEY to .env for full Lighthouse scores.`,
        })
      }
    } finally {
      await page.close().catch(() => null)
      if (owned && session) await session.close()
    }
  } catch (err: any) {
    if (owned && session) await session.close().catch(() => null)
    logger.debug(`Browser performance check failed: ${err.message}`)
    findings.push({
      id: 'cwv-api-unavailable',
      severity: 'info',
      title: 'Core Web Vitals: PageSpeed API unavailable',
      description: 'Could not fetch real Lighthouse scores. Set PAGESPEED_API_KEY in .env for reliable access.',
      recommendation: 'Get a free API key at console.cloud.google.com',
    })
  }
}

export async function runPerformanceCheck(config: SiteConfig, sharedSession?: BrowserSession): Promise<PerformanceResult> {
  const startTime = Date.now()
  const base = baseUrl(config.store_url)
  const findings: Finding[] = []
  const apiKey = process.env.PAGESPEED_API_KEY

  logger.debug(`Running performance check for ${base}`)

  // ── Raw load times (always run, no API key needed) ─────────────────────

  let homeLoadTime = 0
  let checkoutLoadTime = 0
  let thirdPartyScripts: any[] = []

  try {
    const t0 = Date.now()
    await secureFetch(`${base}/`, { timeout: 30000 })
    homeLoadTime = Date.now() - t0
    if (homeLoadTime > 5000) {
      findings.push({
        id: 'slow-homepage',
        severity: homeLoadTime > 10000 ? 'high' : 'medium',
        title: `Homepage server response slow (${(homeLoadTime / 1000).toFixed(1)}s)`,
        description: `Server responded in ${(homeLoadTime / 1000).toFixed(1)}s. This is server response time only — actual render time will be higher.`,
        recommendation: 'Optimise server response, enable CDN caching, reduce app overhead.',
        evidence: `${homeLoadTime}ms`,
      })
    }
  } catch (err) {
    logger.debug(`Failed to measure homepage load time: ${err}`)
  }

  try {
    const t0 = Date.now()
    await secureFetch(`${base}/checkout`, { timeout: 30000 })
    checkoutLoadTime = Date.now() - t0
    if (checkoutLoadTime > 8000) {
      findings.push({
        id: 'slow-checkout',
        severity: 'high',
        title: `Checkout page slow (${(checkoutLoadTime / 1000).toFixed(1)}s)`,
        description: `Checkout server response: ${(checkoutLoadTime / 1000).toFixed(1)}s. Slow checkout directly kills conversions.`,
        recommendation: 'Reduce checkout app overhead, lazy-load non-critical resources.',
      })
    }
  } catch (err) {
    logger.debug(`Failed to measure checkout load time: ${err}`)
  }

  // ── Third-party scripts ────────────────────────────────────────────────

  try {
    const response = await secureFetch(`${base}/`, { timeout: 15000 })
    const html = await response.text()
    const domains = [
      { domain: 'google-analytics.com', name: 'Google Analytics' },
      { domain: 'googletagmanager.com', name: 'Google Tag Manager' },
      { domain: 'facebook.net', name: 'Meta Pixel' },
      { domain: 'tiktok.com', name: 'TikTok Pixel' },
      { domain: 'cdn.segment.com', name: 'Segment' },
      { domain: 'js.intercomcdn.com', name: 'Intercom' },
      { domain: 'gorgias.io', name: 'Gorgias' },
      { domain: 'klaviyo.com', name: 'Klaviyo' },
      { domain: 'static.hotjar.com', name: 'Hotjar' },
    ]
    for (const p of domains) {
      if (html.includes(p.domain)) {
        thirdPartyScripts.push({ domain: p.domain, name: p.name, src: '', size_kb: 0, impact_ms: 0 })
      }
    }
    if (thirdPartyScripts.length > 5) {
      findings.push({
        id: 'many-third-party-scripts',
        severity: 'medium',
        title: `${thirdPartyScripts.length} third-party scripts detected`,
        description: `Found: ${thirdPartyScripts.map(s => s.name).join(', ')}. Each adds network latency.`,
        recommendation: 'Audit scripts. Remove unused ones, lazy-load non-critical ones.',
      })
    }
  } catch (err) {
    logger.debug(`Failed to analyse third-party scripts: ${err}`)
  }

  // ── Core Web Vitals via PageSpeed Insights API ─────────────────────────

  let mobileScores: PageSpeedResult | null = null
  let desktopScores: PageSpeedResult | null = null

  // PSI is an EXTERNAL service — it cannot pass the storefront password gate.
  // On password-protected stores it would silently measure the /password page,
  // producing misleading scores. Use the authenticated local browser instead.
  const psiBlockedByPassword = !!config.storefront_password
  if (psiBlockedByPassword) {
    logger.debug('Store is password-protected — skipping PageSpeed API (it would measure the password page). Using authenticated browser metrics instead.')
    findings.push({
      id: 'cwv-psi-skipped-password',
      severity: 'info',
      title: 'Lighthouse (PageSpeed API) skipped — store is password-protected',
      description:
        'The PageSpeed Insights API cannot log in past the storefront password, so any scores it returned would measure the password page, not the store. Browser-based performance metrics (authenticated session) were collected instead. Re-run after launch for official Lighthouse/CrUX scores.',
    })
  } else {
    logger.debug(`Fetching Core Web Vitals from PageSpeed API (${apiKey ? 'with key' : 'no key — rate limited'})`)
  }

  const [mobile, desktop] = psiBlockedByPassword
    ? [null, null]
    : await Promise.all([
        fetchPageSpeed(config.store_url, 'mobile', apiKey),
        fetchPageSpeed(config.store_url, 'desktop', apiKey),
      ])

  mobileScores = mobile
  desktopScores = desktop

  if (!mobile && !desktop) {
    // PageSpeed API unavailable — run browser-based timing instead
    await runBrowserPerformanceCheck(base, config, findings, sharedSession)
  } else {
    // Mobile CWV findings (most important — Google uses mobile-first indexing)
    if (mobile) {
      // Performance score
      if (mobile.performance < 50) {
        findings.push({
          id: 'cwv-mobile-performance-critical',
          severity: 'critical',
          title: `Mobile performance score critically low: ${mobile.performance}/100`,
          description: `Mobile Lighthouse performance score is ${mobile.performance}/100. Scores below 50 mean a very poor user experience and significant SEO penalty.`,
          recommendation: 'Fix LCP, reduce TBT, eliminate layout shifts. See opportunities below.',
          evidence: `Mobile: ${mobile.performance}/100`,
        })
      } else if (mobile.performance < 70) {
        findings.push({
          id: 'cwv-mobile-performance-low',
          severity: 'high',
          title: `Mobile performance needs improvement: ${mobile.performance}/100`,
          description: `Mobile score ${mobile.performance}/100. Google recommends 90+.`,
          recommendation: 'Focus on LCP and TBT optimisation.',
          evidence: `Mobile: ${mobile.performance}/100`,
        })
      } else if (mobile.performance < 90) {
        findings.push({
          id: 'cwv-mobile-performance-medium',
          severity: 'medium',
          title: `Mobile performance could be better: ${mobile.performance}/100`,
          description: `Mobile score ${mobile.performance}/100. Target is 90+.`,
        })
      }

      // LCP
      if (mobile.lcp_ms > 4000) {
        findings.push({
          id: 'cwv-lcp-poor',
          severity: 'critical',
          title: `LCP too slow: ${(mobile.lcp_ms / 1000).toFixed(1)}s (threshold: 2.5s)`,
          description: `Largest Contentful Paint is ${(mobile.lcp_ms / 1000).toFixed(1)}s on mobile. This is the time until the main content is visible. Poor LCP = users see a blank page for too long.`,
          recommendation: 'Optimise hero image (preload, WebP, correct size). Reduce server response time. Enable Shopify CDN.',
          evidence: `LCP: ${(mobile.lcp_ms / 1000).toFixed(1)}s`,
        })
      } else if (mobile.lcp_ms > 2500) {
        findings.push({
          id: 'cwv-lcp-needs-improvement',
          severity: 'high',
          title: `LCP needs improvement: ${(mobile.lcp_ms / 1000).toFixed(1)}s (threshold: 2.5s)`,
          description: `LCP is ${(mobile.lcp_ms / 1000).toFixed(1)}s on mobile. Target is under 2.5s.`,
          recommendation: 'Preload hero image, use WebP format, reduce render-blocking resources.',
          evidence: `LCP: ${(mobile.lcp_ms / 1000).toFixed(1)}s`,
        })
      }

      // CLS
      if (mobile.cls > 0.25) {
        findings.push({
          id: 'cwv-cls-poor',
          severity: 'critical',
          title: `CLS too high: ${mobile.cls} (threshold: 0.1)`,
          description: `Cumulative Layout Shift is ${mobile.cls}. Elements are jumping around while the page loads — very frustrating for users, especially on mobile.`,
          recommendation: 'Add width/height to all images and videos. Avoid inserting content above existing content. Reserve space for ads/embeds.',
          evidence: `CLS: ${mobile.cls}`,
        })
      } else if (mobile.cls > 0.1) {
        findings.push({
          id: 'cwv-cls-needs-improvement',
          severity: 'high',
          title: `CLS needs improvement: ${mobile.cls} (threshold: 0.1)`,
          description: `Layout shift score of ${mobile.cls}. Target is under 0.1.`,
          recommendation: 'Add explicit dimensions to images. Check for late-loading fonts or ads.',
          evidence: `CLS: ${mobile.cls}`,
        })
      }

      // TBT (proxy for FID/INP)
      if (mobile.tbt_ms > 600) {
        findings.push({
          id: 'cwv-tbt-poor',
          severity: 'high',
          title: `Total Blocking Time too high: ${mobile.tbt_ms}ms (threshold: 300ms)`,
          description: `TBT is ${mobile.tbt_ms}ms on mobile. This means JavaScript is blocking the main thread for ${mobile.tbt_ms}ms, making the page feel unresponsive to taps/clicks.`,
          recommendation: 'Defer non-critical JavaScript. Split large JS bundles. Remove unused code.',
          evidence: `TBT: ${mobile.tbt_ms}ms`,
        })
      } else if (mobile.tbt_ms > 300) {
        findings.push({
          id: 'cwv-tbt-needs-improvement',
          severity: 'medium',
          title: `Total Blocking Time elevated: ${mobile.tbt_ms}ms`,
          description: `TBT ${mobile.tbt_ms}ms on mobile. Target is under 300ms.`,
          recommendation: 'Defer or async-load non-critical scripts.',
          evidence: `TBT: ${mobile.tbt_ms}ms`,
        })
      }

      // Mobile vs Desktop gap
      if (desktop && desktop.performance - mobile.performance > 20) {
        findings.push({
          id: 'cwv-mobile-desktop-gap',
          severity: 'medium',
          title: `Mobile score (${mobile.performance}) significantly lower than desktop (${desktop.performance})`,
          description: `${desktop.performance - mobile.performance} point gap between desktop and mobile. Mobile users get a much worse experience. Google uses mobile-first indexing.`,
          recommendation: 'Prioritise mobile optimisation: smaller images, fewer scripts on mobile, responsive images.',
          evidence: `Mobile: ${mobile.performance}, Desktop: ${desktop.performance}`,
        })
      }

      // Top opportunities
      if (mobile.opportunities.length > 0) {
        findings.push({
          id: 'cwv-opportunities',
          severity: 'info',
          title: `Top performance opportunities (mobile)`,
          description: mobile.opportunities.map(o => `• ${o.title} (~${(o.savings_ms / 1000).toFixed(1)}s saving)`).join('\n'),
          recommendation: 'Address highest-saving opportunities first.',
        })
      }

      // All clear
      if (mobile.performance >= 90 && mobile.lcp_ms <= 2500 && mobile.cls <= 0.1) {
        findings.push({
          id: 'cwv-excellent',
          severity: 'info',
          title: `Core Web Vitals: Excellent ✅ (mobile ${mobile.performance}/100)`,
          description: `Performance ${mobile.performance}/100, LCP ${(mobile.lcp_ms / 1000).toFixed(1)}s, CLS ${mobile.cls}. All Core Web Vitals pass.`,
        })
      }
    }
  }

  const mobileFinal = mobileScores ?? { performance: 0, accessibility: 0, best_practices: 0, seo: 0, fcp_ms: 0, lcp_ms: homeLoadTime, fid_ms: 0, cls: 0, tbt_ms: 0, speed_index_ms: 0, tti_ms: 0 }
  const desktopFinal = desktopScores ?? { performance: 0, accessibility: 0, best_practices: 0, seo: 0, fcp_ms: 0, lcp_ms: homeLoadTime, fid_ms: 0, cls: 0, tbt_ms: 0, speed_index_ms: 0, tti_ms: 0 }

  return {
    id: 'performance',
    name: 'Performance Audit',
    status: findings.some(f => f.severity === 'critical') ? 'fail' : findings.some(f => f.severity === 'high') ? 'warning' : 'pass',
    duration_ms: Date.now() - startTime,
    findings,
    lighthouse_scores: {
      mobile:   { performance: mobileFinal.performance,  accessibility: mobileFinal.accessibility,  best_practices: mobileFinal.best_practices, seo: mobileFinal.seo,  fcp_ms: mobileFinal.fcp_ms,  lcp_ms: mobileFinal.lcp_ms,  fid_ms: mobileFinal.fid_ms,  cls: mobileFinal.cls,  tbt_ms: mobileFinal.tbt_ms,  speed_index_ms: mobileFinal.speed_index_ms  },
      desktop:  { performance: desktopFinal.performance, accessibility: desktopFinal.accessibility, best_practices: desktopFinal.best_practices, seo: desktopFinal.seo, fcp_ms: desktopFinal.fcp_ms, lcp_ms: desktopFinal.lcp_ms, fid_ms: desktopFinal.fid_ms, cls: desktopFinal.cls, tbt_ms: desktopFinal.tbt_ms, speed_index_ms: desktopFinal.speed_index_ms },
    },
    pages_tested: 2,
    avg_load_time_ms: (homeLoadTime + checkoutLoadTime) / 2,
    third_party_scripts: thirdPartyScripts,
  }
}
