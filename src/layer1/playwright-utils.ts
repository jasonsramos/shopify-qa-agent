import { Browser, BrowserContext, Page } from 'playwright'
import axios from 'axios'
import { logger } from '../utils.js'

const STEALTH_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

/**
 * Create a stealth Playwright context with no initial navigation.
 */
export async function createContext(browser: Browser): Promise<BrowserContext> {
  const context = await browser.newContext({ userAgent: STEALTH_UA })
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false })
  })
  return context
}

/**
 * Bypass Shopify's storefront password by POSTing directly to /password
 * and injecting the returned session cookie into the Playwright context.
 * This is called ONCE per context — all pages opened from that context
 * automatically inherit the session cookie.
 */
export async function bypassStorefrontPassword(
  context: BrowserContext,
  base: string,
  storefrontPassword: string
): Promise<void> {
  try {
    const hostname = new URL(base).hostname

    const response = await axios.post(
      `${base}/password`,
      `form_type=storefront_password&utf8=%E2%9C%93&password=${encodeURIComponent(storefrontPassword)}`,
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': STEALTH_UA,
        },
        maxRedirects: 0,
        validateStatus: (s) => s < 500,
      }
    )

    const rawCookies: string[] = Array.isArray(response.headers['set-cookie'])
      ? response.headers['set-cookie']
      : response.headers['set-cookie']
        ? [response.headers['set-cookie'] as string]
        : []

    const cookies = rawCookies
      .map((c) => {
        const m = c.match(/^([^=]+)=([^;]*)/)
        if (!m) return null
        return { name: m[1].trim(), value: m[2].trim(), domain: hostname, path: '/' }
      })
      .filter((c): c is { name: string; value: string; domain: string; path: string } => c !== null)

    if (cookies.length > 0) {
      await context.addCookies(cookies)
      logger.debug(`✓ Storefront password accepted — ${cookies.length} session cookie(s) injected`)
    } else {
      logger.warn('Storefront password submitted but no cookies returned — check the password is correct')
    }
  } catch (err: any) {
    logger.warn(`Storefront password bypass failed: ${err.message}`)
  }
}

/**
 * Take a screenshot after waiting for the page to fully render.
 * Scrolls slightly to trigger intersection-observer lazy loading, then scrolls back.
 */
export async function screenshotWhenLoaded(page: Page, filePath: string): Promise<void> {
  try {
    await page.waitForLoadState('load', { timeout: 10000 }).catch(() => null)
    // Scroll down to trigger IntersectionObserver / lazy-load, then back to top
    await page.evaluate(() => window.scrollBy(0, 300)).catch(() => null)
    await page.waitForTimeout(500)
    await page.evaluate(() => window.scrollTo(0, 0)).catch(() => null)
    // Wait for JS carousels / hero images to render
    await page.waitForTimeout(2000)
    await page.screenshot({ path: filePath, fullPage: false })
  } catch {
    // non-fatal
  }
}
