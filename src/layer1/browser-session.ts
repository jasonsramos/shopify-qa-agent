import { Browser, BrowserContext, Page, chromium } from 'playwright'
import { SiteConfig, Finding } from '../types.js'
import { baseUrl, secureFetch, logger } from '../utils.js'
import { createContext, bypassStorefrontPassword } from './playwright-utils.js'

/**
 * A shared browser session used by all browser-based Layer 1 checks.
 *
 * Launches Chromium ONCE, creates ONE authenticated context (password bypassed
 * once), and is reused across every check. Also caches the homepage HTML and the
 * homepage response headers so the ~6 checks that re-fetch `/` share one request.
 *
 * Backward-compatible: checks that don't accept a session just keep launching
 * their own browser as before.
 */
export class BrowserSession {
  readonly base: string
  private browser: Browser | null = null
  private context: BrowserContext | null = null
  private homeHtml: string | null = null
  private homeHeaders: Record<string, string> | null = null
  private homeSetCookies: string[] = []
  private initialized = false

  constructor(private config: SiteConfig) {
    this.base = baseUrl(config.store_url)
  }

  /**
   * Return a ready session to use, plus whether the caller owns it (and must
   * close it). If a ready shared session is passed, reuse it (owned=false);
   * otherwise create and init a fresh one (owned=true).
   */
  static async acquire(
    config: SiteConfig,
    provided?: BrowserSession
  ): Promise<{ session: BrowserSession; owned: boolean }> {
    if (provided && provided.ready) return { session: provided, owned: false }
    const session = new BrowserSession(config)
    await session.init()
    return { session, owned: true }
  }

  /** Launch the browser + authenticated context once. Safe to call repeatedly. */
  async init(): Promise<void> {
    if (this.initialized) return
    this.initialized = true

    this.browser = await chromium.launch({
      headless: process.env.QA_HEADLESS !== 'false',
      args: ['--disable-blink-features=AutomationControlled', '--disable-dev-shm-usage'],
    })
    this.context = await createContext(this.browser)
    if (this.config.storefront_password) {
      await bypassStorefrontPassword(this.context, this.base, this.config.storefront_password)
    }
    logger.debug('BrowserSession initialized (1 browser, 1 authenticated context)')
  }

  /** True when a usable context exists. */
  get ready(): boolean {
    return !!this.context
  }

  /** Open a new page in the shared (authenticated) context. */
  async newPage(): Promise<Page> {
    if (!this.context) await this.init()
    if (!this.context) throw new Error('BrowserSession context unavailable')
    return this.context.newPage()
  }

  /**
   * Fetch the homepage once and cache HTML + headers + set-cookie. Subsequent
   * callers receive the cached copy. Uses secureFetch so it works without a
   * browser if the store isn't password-protected.
   */
  private async loadHome(): Promise<void> {
    if (this.homeHtml !== null) return

    // Password-protected stores need the browser context to see real content.
    if (this.config.storefront_password && this.context) {
      const page = await this.context.newPage()
      try {
        const response = await page.goto(this.base, { waitUntil: 'domcontentloaded', timeout: 15000 })
        this.homeHtml = await page.content()
        const hdrs = response?.headers() ?? {}
        this.homeHeaders = hdrs
        // Playwright merges set-cookie into one header; split defensively
        if (hdrs['set-cookie']) this.homeSetCookies = hdrs['set-cookie'].split('\n')
        return
      } catch (err: any) {
        logger.debug(`BrowserSession home load (browser) failed: ${err.message}`)
        this.homeHtml = ''
        this.homeHeaders = {}
        return
      } finally {
        await page.close().catch(() => null)
      }
    }

    // Public store — a plain fetch is faster and exposes raw set-cookie headers.
    try {
      const res = await secureFetch(this.base, { timeout: 15000 })
      this.homeHtml = await res.text()
      const hdrs: Record<string, string> = {}
      res.headers.forEach((v, k) => (hdrs[k] = v))
      this.homeHeaders = hdrs
      // Node fetch exposes combined set-cookie via getSetCookie() when available
      const anyHeaders = res.headers as any
      if (typeof anyHeaders.getSetCookie === 'function') {
        this.homeSetCookies = anyHeaders.getSetCookie()
      } else if (hdrs['set-cookie']) {
        this.homeSetCookies = [hdrs['set-cookie']]
      }
    } catch (err: any) {
      logger.debug(`BrowserSession home load (fetch) failed: ${err.message}`)
      this.homeHtml = ''
      this.homeHeaders = {}
    }
  }

  async getHomeHtml(): Promise<string> {
    await this.loadHome()
    return this.homeHtml ?? ''
  }

  async getHomeHeaders(): Promise<Record<string, string>> {
    await this.loadHome()
    return this.homeHeaders ?? {}
  }

  async getHomeSetCookies(): Promise<string[]> {
    await this.loadHome()
    return this.homeSetCookies
  }

  /**
   * Fetch an arbitrary URL through the authenticated session so its cookies
   * (including the storefront-password bypass) are carried. On password-locked
   * stores this returns real content for URLs like /sitemap.xml and /robots.txt
   * instead of the /password gate. Falls back to a plain fetch when no browser
   * context exists (public store or session failed to launch). Never throws.
   */
  async fetchDoc(
    url: string,
    opts: { method?: string; maxRedirects?: number; timeoutMs?: number } = {}
  ): Promise<{ ok: boolean; status: number; text: string }> {
    const { method = 'GET', maxRedirects = 5, timeoutMs = 15000 } = opts
    if (this.config.storefront_password && this.context) {
      try {
        const resp = await this.context.request.fetch(url, { method, maxRedirects, timeout: timeoutMs })
        return { ok: resp.ok(), status: resp.status(), text: method === 'HEAD' ? '' : await resp.text() }
      } catch (err: any) {
        logger.debug(`BrowserSession fetchDoc failed for ${url}: ${err.message}`)
        return { ok: false, status: 0, text: '' }
      }
    }
    try {
      const res = await secureFetch(url, {
        method,
        timeout: timeoutMs,
        redirect: maxRedirects === 0 ? 'manual' : 'follow',
      })
      return { ok: res.ok, status: res.status, text: method === 'HEAD' ? '' : await res.text() }
    } catch (err: any) {
      logger.debug(`BrowserSession fetchDoc (fetch) failed for ${url}: ${err.message}`)
      return { ok: false, status: 0, text: '' }
    }
  }

  /** Get the underlying authenticated context (e.g. for sitemap nav crawl). */
  getContext(): BrowserContext | null {
    return this.context
  }

  async close(): Promise<void> {
    try {
      if (this.context) await this.context.close()
    } catch {
      /* ignore */
    }
    try {
      if (this.browser) await this.browser.close()
    } catch {
      /* ignore */
    }
    this.context = null
    this.browser = null
  }
}
