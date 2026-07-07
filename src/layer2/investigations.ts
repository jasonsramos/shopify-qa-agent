import path from 'path'
import { SiteConfig, Layer1Results, Layer2InvestigationResult } from '../types.js'
import { baseUrl, logger } from '../utils.js'
import { BrowserSession } from '../layer1/browser-session.js'
import { screenshotWhenLoaded } from '../layer1/playwright-utils.js'
import { ShopifyAdminClient } from '../shopify-api.js'

/**
 * Dynamic, automated Layer 2 investigations (zero-API).
 *
 * Each investigation is TRIGGERED by Layer 1 findings and runs a focused
 * Playwright re-test using the shared browser session, capturing screenshots.
 * This mirrors the WP agent's dynamic investigation coverage without any AI/API
 * calls. The generated layer2-prompt.md (see prompt-builder) lets a Claude Code
 * operator go deeper via Playwright MCP.
 */

const findingsOf = (l1: Layer1Results, checkId: string) =>
  l1.all_checks.filter((c) => c.id === checkId).flatMap((c) => c.findings)

const hasSeverity = (l1: Layer1Results, checkId: string, sev: string[]) =>
  findingsOf(l1, checkId).some((f) => sev.includes(f.severity))

export async function runDynamicInvestigations(
  config: SiteConfig,
  l1: Layer1Results,
  screenshotsDir: string,
  session: BrowserSession
): Promise<Layer2InvestigationResult[]> {
  const base = baseUrl(config.store_url)
  const results: Layer2InvestigationResult[] = []
  const snap = async (page: any, name: string): Promise<string> => {
    const file = path.join(screenshotsDir, `l2-${name}.png`)
    await screenshotWhenLoaded(page, file)
    return `l2-${name}.png`
  }

  // ── 1. Deep checkout flow (always, but escalates if Layer 1 flagged checkout) ──
  try {
    const checkoutFlagged = hasSeverity(l1, 'shopify-checkout', ['critical', 'high'])
    const shots: string[] = []
    const issues: Layer2InvestigationResult['issues'] = []
    let api: ShopifyAdminClient | null = null
    try {
      api = new ShopifyAdminClient(config)
    } catch {
      /* no token */
    }
    const handle = api ? await api.getFirstProductHandle().catch(() => null) : null

    const page = await session.newPage()
    try {
      await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => null)
      shots.push(await snap(page, 'checkout-1-home'))

      if (handle) {
        await page.goto(`${base}/products/${handle}`, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => null)
        shots.push(await snap(page, 'checkout-2-product'))

        // Step 3: Add to cart — click button (like a real user), then VERIFY via /cart.js
        const addBtn = await page.$('button[name="add"], button:has-text("Add to cart"), button:has-text("Add to Cart"), [data-action="add-to-cart"]')
        if (addBtn) {
          await addBtn.click({ force: true }).catch(() => null)
          // Wait for cart drawer or page update
          await page.waitForTimeout(2500)
        }
        shots.push(await snap(page, 'checkout-2b-add-to-cart'))

        // Verify (and if needed, add) via the AJAX Cart API — theme-agnostic
        let itemCount: number = await page
          .evaluate(async () => {
            const res = await fetch('/cart.js', { headers: { Accept: 'application/json' } })
            return res.ok ? (await res.json()).item_count ?? 0 : -1
          })
          .catch(() => -1)
        if (itemCount === 0) {
          const added = await page
            .evaluate(async (h: string) => {
              const prod = await fetch(`/products/${h}.js`, { headers: { Accept: 'application/json' } })
              if (!prod.ok) return false
              const data = await prod.json()
              const variant = (data.variants || []).find((v: any) => v.available) || data.variants?.[0]
              if (!variant) return false
              const res = await fetch('/cart/add.js', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
                body: JSON.stringify({ id: variant.id, quantity: 1 }),
              })
              return res.ok
            }, handle)
            .catch(() => false)
          if (added) {
            itemCount = await page
              .evaluate(async () => {
                const res = await fetch('/cart.js', { headers: { Accept: 'application/json' } })
                return res.ok ? (await res.json()).item_count ?? 0 : -1
              })
              .catch(() => -1)
          }
          if (itemCount === 0) {
            issues.push({
              severity: 'blocker',
              title: 'Cannot add item to cart (verified via Cart API)',
              description: `Both the add-to-cart button and the AJAX Cart API (/cart/add.js) failed to add /products/${handle} — /cart.js reports 0 items. This is a real cart failure.`,
              location: `${base}/products/${handle}`,
              how_to_fix: 'Check product/variant availability and theme cart JS for errors.',
            })
          }
        }

        // Step 4: Cart page screenshot (cart state already verified via API)
        await page.goto(`${base}/cart`, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => null)
        await page.waitForTimeout(2000)
        shots.push(await snap(page, 'checkout-3-cart'))

        // Step 5: Navigate DIRECTLY to /checkout — works on every Shopify store,
        // independent of what the theme's checkout button looks like.
        if (itemCount > 0) {
          await page.goto(`${base}/checkout`, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => null)
          // Wait for checkout form to fully render (Contact, Delivery, Payment sections)
          await page.waitForTimeout(4000)
          shots.push(await snap(page, 'checkout-4-checkout'))

          const url: string = page.url()
          const reachedCheckout = /\/checkouts?\/|checkout\.shopify\.com/.test(url)
          const hitCheckpoint = /\/checkpoint|\/throttle|hcaptcha|challenge/i.test(url)

          if (!reachedCheckout) {
            issues.push({
              severity: hitCheckpoint ? 'minor' : 'blocker',
              title: hitCheckpoint ? 'Checkout blocked by bot protection (unverifiable)' : 'Checkout page did not load',
              description: hitCheckpoint
                ? `Navigating to /checkout landed on a bot-protection page (${url}). Checkout could not be verified by automation — this does NOT necessarily mean checkout is broken. Verify manually.`
                : `Navigating to /checkout with ${itemCount} item(s) in cart landed on ${url} instead of a Shopify checkout URL.`,
              location: `${base}/checkout`,
              how_to_fix: hitCheckpoint ? 'Verify checkout manually in a browser.' : 'Verify checkout is enabled in store settings.',
            })
          } else {
            const email = await page.$('input[type="email"], #email, input[autocomplete="email"]')
            const pay = await page.$('[class*="payment"], [data-checkout-payment], button:has-text("Pay"), input[class*="card"], #card-number, iframe[src*="card-fields"]')
            // Only assert on fields now that we KNOW we are on checkout. Payment often lives
            // on a later step of multi-step checkout — treat as minor, not blocker.
            if (!email) issues.push({ severity: 'major', title: 'Checkout missing email field', description: `Reached checkout (${url}) but no email input found in the Contact section.`, location: url })
            if (!pay) issues.push({ severity: 'minor', title: 'Payment section not visible on checkout first step', description: 'No payment UI visible on the first checkout step. Multi-step checkouts show payment later — verify manually before treating as a defect.', location: url, how_to_fix: 'Confirm payment providers in Shopify Admin → Settings → Payments.' })
          }
        }
      } else {
        issues.push({ severity: 'major', title: 'No product available to test checkout', description: 'Could not find a published product to drive the checkout flow.', location: base })
      }
    } finally {
      await page.close().catch(() => null)
    }

    results.push({
      id: 'checkout-flow-deep',
      status: issues.some((i) => i.severity === 'blocker') ? 'fail' : issues.length > 0 ? 'warning' : 'pass',
      summary: issues.length === 0 ? 'Deep checkout flow completed successfully' : `Deep checkout flow found ${issues.length} issue(s)`,
      details: `Drove homepage → product → cart → checkout${checkoutFlagged ? ' (escalated: Layer 1 flagged checkout)' : ''}. Screenshots captured at each step.`,
      screenshots: shots,
      issues,
    })
  } catch (err: any) {
    logger.debug(`checkout-flow-deep investigation failed: ${err.message}`)
  }

  // ── 2. Visual assessment (always) — mobile + desktop of key pages + footer ──
  try {
    const shots: string[] = []
    const issues: Layer2InvestigationResult['issues'] = []
    const targets = [
      { path: '/', name: 'home' },
      { path: '/products', name: 'products' },
      { path: '/cart', name: 'cart' },
    ]

    // Desktop screenshots for key pages
    for (const t of targets) {
      const page = await session.newPage()
      try {
        await page.setViewportSize({ width: 1440, height: 900 })
        await page.goto(`${base}${t.path}`, { waitUntil: 'domcontentloaded', timeout: 12000 }).catch(() => null)
        await page.waitForTimeout(1500)
        shots.push(await snap(page, `visual-${t.name}-desktop`))
      } finally {
        await page.close().catch(() => null)
      }
    }

    // Mobile screenshots + overflow check for key pages
    for (const t of targets) {
      const page = await session.newPage()
      try {
        await page.setViewportSize({ width: 375, height: 812 })
        await page.goto(`${base}${t.path}`, { waitUntil: 'domcontentloaded', timeout: 12000 }).catch(() => null)
        await page.waitForTimeout(1500)
        shots.push(await snap(page, `visual-${t.name}-mobile`))

        const textLen = await page.evaluate(() => (document.body?.innerText || '').trim().length).catch(() => 1)
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth).catch(() => false)
        const brokenImages = await page.evaluate(() =>
          Array.from(document.images).filter((i) => i.complete && i.naturalWidth === 0 && i.src).length
        ).catch(() => 0)

        if (textLen < 30) {
          issues.push({
            severity: 'major',
            title: `Blank/broken render on ${t.path} (mobile)`,
            description: `Page body has almost no visible text (${textLen} chars) at 375px — may indicate a render or JS failure.`,
            location: `${base}${t.path}`,
          })
        }
        if (overflow) {
          issues.push({
            severity: 'major',
            title: `Horizontal overflow on ${t.path} (mobile)`,
            description: `Page scrolls horizontally at 375px — content overflows the mobile viewport width.`,
            location: `${base}${t.path}`,
            how_to_fix: 'Check CSS for fixed-width elements on this page template. Add overflow-x: hidden or fix max-width.',
          })
        }
        if (brokenImages > 0) {
          issues.push({
            severity: 'minor',
            title: `${brokenImages} broken image(s) on ${t.path} (mobile)`,
            description: `${brokenImages} images failed to load at 375px viewport on ${t.path}.`,
            location: `${base}${t.path}`,
            how_to_fix: 'Check image URLs and re-upload via Shopify Admin → Content → Files.',
          })
        }
      } finally {
        await page.close().catch(() => null)
      }
    }

    // Footer screenshot + link checking (desktop, homepage)
    const footerPage = await session.newPage()
    try {
      await footerPage.setViewportSize({ width: 1440, height: 900 })
      await footerPage.goto(base, { waitUntil: 'domcontentloaded', timeout: 12000 }).catch(() => null)
      await footerPage.waitForTimeout(1500)

      // Scroll to bottom and screenshot footer
      await footerPage.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
      await footerPage.waitForTimeout(800)
      shots.push(await snap(footerPage, 'visual-footer-desktop'))

      // Collect all footer links
      const footerLinks = await footerPage.$$eval(
        'footer a[href], [class*="footer"] a[href], [id*="footer"] a[href]',
        (els, siteBase) => {
          const seen = new Set<string>()
          return els
            .map((el) => ({ href: (el as HTMLAnchorElement).href, text: (el as HTMLAnchorElement).textContent?.trim().slice(0, 60) || '' }))
            .filter((l) => {
              if (!l.href || seen.has(l.href)) return false
              if (!l.href.startsWith(siteBase)) return false // skip external
              if (l.href.includes('#')) return false // skip anchors
              seen.add(l.href)
              return true
            })
        },
        base
      ).catch(() => [] as { href: string; text: string }[])

      // Check each footer link
      for (const link of footerLinks.slice(0, 15)) {
        const linkPage = await session.newPage()
        const consoleErrors: string[] = []
        linkPage.on('console', (msg) => {
          if (msg.type() === 'error') consoleErrors.push(msg.text().slice(0, 120))
        })
        try {
          await linkPage.setViewportSize({ width: 1440, height: 900 })
          const resp = await linkPage.goto(link.href, { waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => null)
          await linkPage.waitForTimeout(1000)
          const status = resp?.status() ?? 0
          const slug = link.text.replace(/[^a-z0-9]/gi, '-').toLowerCase().slice(0, 20) || 'link'
          shots.push(await snap(linkPage, `visual-footer-link-${slug}`))

          // Check text content
          const textLen = await linkPage.evaluate(() => (document.body?.innerText || '').trim().length).catch(() => 0)

          // Check horizontal overflow
          const overflow = await linkPage.evaluate(() => {
            return document.documentElement.scrollWidth > document.documentElement.clientWidth
          }).catch(() => false)

          // Check broken images
          const brokenImages = await linkPage.evaluate(() => {
            return Array.from(document.images)
              .filter((img) => img.complete && img.naturalWidth === 0 && img.src)
              .map((img) => img.src.split('/').pop() || img.src)
              .slice(0, 3)
          }).catch(() => [] as string[])

          if (status === 404) {
            issues.push({
              severity: 'major',
              title: `Footer link returns 404: "${link.text}"`,
              description: `Footer link "${link.text}" (${link.href}) returns HTTP 404.`,
              location: link.href,
              how_to_fix: 'Fix or remove the broken footer link in Shopify Admin → Online Store → Themes → Customize → Footer.',
            })
          } else {
            if (textLen < 30) {
              issues.push({
                severity: 'minor',
                title: `Footer link "${link.text}" loads blank page`,
                description: `Page at ${link.href} has almost no visible text (${textLen} chars). May be unpublished or empty.`,
                location: link.href,
                how_to_fix: 'Add content to this page in Shopify Admin → Online Store → Pages.',
              })
            }
            if (overflow) {
              issues.push({
                severity: 'minor',
                title: `Horizontal overflow on "${link.text}" page`,
                description: `Page at ${link.href} scrolls horizontally at 1440px — content wider than viewport.`,
                location: link.href,
                how_to_fix: 'Check CSS for fixed-width elements or missing max-width on the page template.',
              })
            }
            if (brokenImages.length > 0) {
              issues.push({
                severity: 'minor',
                title: `Broken images on "${link.text}" page`,
                description: `${brokenImages.length} broken image(s) on ${link.href}: ${brokenImages.join(', ')}`,
                location: link.href,
                how_to_fix: 'Re-upload missing images via Shopify Admin → Content → Files.',
              })
            }
            if (consoleErrors.length > 0) {
              issues.push({
                severity: 'minor',
                title: `Console errors on "${link.text}" page`,
                description: `${consoleErrors.length} JS error(s) on ${link.href}: ${consoleErrors[0]}`,
                location: link.href,
                how_to_fix: 'Debug JavaScript errors in browser DevTools on this page.',
              })
            }
          }
        } finally {
          await linkPage.close().catch(() => null)
        }
      }

      if (footerLinks.length === 0) {
        issues.push({
          severity: 'minor',
          title: 'No footer links found',
          description: 'Could not detect any internal links in the footer. Footer may be missing or uses a non-standard structure.',
          location: base,
          how_to_fix: 'Check footer content in Shopify Admin → Online Store → Themes → Customize → Footer.',
        })
      }
    } finally {
      await footerPage.close().catch(() => null)
    }

    results.push({
      id: 'visual-assessment',
      status: issues.some((i) => i.severity === 'major' || i.severity === 'blocker') ? 'warning' : 'pass',
      summary: issues.length > 0 ? `Visual assessment flagged ${issues.length} issue(s)` : 'Visual assessment passed — no render failures, footer links checked',
      details: `Captured desktop (1440×900) and mobile (375×812) screenshots of home, products, and cart. Scrolled to footer, screenshotted it, and checked ${0} footer link(s).`,
      screenshots: shots,
      issues,
    })
  } catch (err: any) {
    logger.debug(`visual-assessment investigation failed: ${err.message}`)
  }

  // ── 3. Security high-risk verification (only if Layer 1 found critical/high security) ──
  const securityHigh = findingsOf(l1, 'security').filter((f) => f.severity === 'critical' || f.severity === 'high')
  if (securityHigh.length > 0) {
    // NOTE: do NOT copy the L1 findings into `issues` — they are already counted
    // in the Layer 1 section of the merged report and would be double-counted.
    results.push({
      id: 'security-high-risk-verify',
      status: securityHigh.some((f) => f.severity === 'critical') ? 'fail' : 'warning',
      summary: `${securityHigh.length} high-risk security finding(s) from Layer 1 need manual verification`,
      details: `These Layer 1 security findings warrant manual confirmation of real-world exploitability: ${securityHigh
        .map((f) => f.title)
        .join('; ')}. See the Layer 1 findings for details (not re-listed here to avoid double-counting).`,
      screenshots: [],
      issues: [],
    })
  }

  // ── 4. Accessibility critical (only if axe found critical/serious) ──
  const a11yCritical = findingsOf(l1, 'accessibility').filter((f) => f.severity === 'critical' || f.severity === 'high')
  if (a11yCritical.length > 0) {
    // NOTE: do NOT copy the L1 axe findings into `issues` — they are already
    // counted in the Layer 1 section of the merged report and would be
    // double-counted (the June/July Vingtor reports listed each axe finding twice).
    results.push({
      id: 'accessibility-critical',
      status: 'warning',
      summary: `${a11yCritical.length} critical/serious accessibility issue(s) to verify`,
      details: `Layer 1 axe-core scan flagged high-impact WCAG violations: ${a11yCritical
        .map((f) => f.title)
        .join('; ')}. Confirm with keyboard + screen-reader testing. See the Layer 1 accessibility findings for element-level detail (not re-listed here to avoid double-counting).`,
      screenshots: [],
      issues: [],
    })
  }

  // ── 5. Console-error impact (only if Layer 1 found console/network errors) ──
  const consoleErrs = findingsOf(l1, 'console-network-errors').filter((f) => f.severity !== 'info')
  if (consoleErrs.length > 0) {
    results.push({
      id: 'console-errors-impact',
      status: consoleErrs.some((f) => f.severity === 'critical') ? 'fail' : 'warning',
      summary: `${consoleErrs.length} page(s) had console/network errors`,
      details: `Confirm whether these runtime errors degrade the user experience (broken widgets, failed tracking, checkout JS): ${consoleErrs
        .map((f) => f.title)
        .join('; ')}. See the Layer 1 findings for details (not re-listed here to avoid double-counting).`,
      screenshots: [],
      issues: [],
    })
  }

  // ── 6. Broken pages (only if Site-Wide Scan or Page Health found 404s/load failures) ──
  const brokenPages = [...findingsOf(l1, 'site-wide-scan'), ...findingsOf(l1, 'page-health')].filter(
    (f) => /404|failed to load|broken/i.test(f.title) && f.severity !== 'info'
  )
  if (brokenPages.length > 0) {
    results.push({
      id: 'broken-pages',
      status: 'warning',
      summary: `${brokenPages.length} broken-page finding(s) to investigate`,
      details: `Pages in the sitemap or key-page set returned errors. Verify and redirect or fix: ${brokenPages
        .map((f) => f.title)
        .join('; ')}. See the Layer 1 findings for details (not re-listed here to avoid double-counting).`,
      screenshots: [],
      issues: [],
    })
  }

  return results
}
