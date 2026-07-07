import { SiteConfig, CheckResult, Finding } from '../../types.js'
import { baseUrl, logger } from '../../utils.js'
import { ShopifyAdminClient } from '../../shopify-api.js'
import path from 'path'
import { screenshotWhenLoaded } from '../playwright-utils.js'
import { BrowserSession } from '../browser-session.js'

/**
 * Read the live cart state via Shopify's AJAX Cart API (/cart.js).
 * Theme-agnostic and definitive — works for drawer carts, page carts, and
 * headless-ish themes where DOM selector heuristics fail.
 */
async function getCartState(page: any): Promise<{ item_count: number } | null> {
  return page
    .evaluate(async () => {
      const res = await fetch('/cart.js', { headers: { Accept: 'application/json' } })
      if (!res.ok) return null
      const data = await res.json()
      return { item_count: data.item_count ?? 0 }
    })
    .catch(() => null)
}

/** Add the first available variant of a product via /cart/add.js (fallback when the button click doesn't register). */
async function addViaCartApi(page: any, handle: string): Promise<boolean> {
  return page
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
}

export async function runShopifyCheckoutAutomatedCheck(
  config: SiteConfig,
  screenshotsDir?: string,
  sharedSession?: BrowserSession
): Promise<CheckResult> {
  const startTime = Date.now()
  const findings: Finding[] = []
  const base = baseUrl(config.store_url)

  const snap = async (page: any, name: string) => {
    if (!screenshotsDir) return
    await screenshotWhenLoaded(page, path.join(screenshotsDir, `checkout-${name}.png`))
  }

  let owned = false
  let session: BrowserSession | null = null

  try {
    // Get a real product handle from the Admin API so we can navigate directly
    let productHandle: string | null = null
    try {
      const api = new ShopifyAdminClient(config)
      productHandle = await api.getFirstProductHandle()
    } catch (err: any) {
      logger.debug(`Could not get product handle from Admin API: ${err.message}`)
    }

    ;({ session, owned } = await BrowserSession.acquire(config, sharedSession))
    const page = await session.newPage()

    try {
      // Step 1: Homepage screenshot
      logger.debug('Opening store homepage')
      await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => null)
      await snap(page, '1-homepage')

      // Step 2: Navigate directly to first product page (skip clicking homepage links)
      if (!productHandle) {
        findings.push({
          id: 'checkout-auto-no-products',
          severity: 'critical',
          title: 'No published products found in store',
          description: 'Could not find any active products via Admin API.',
          recommendation: 'Ensure products are published and visible.',
        })
      } else {
        const productUrl = `${base}/products/${productHandle}`
        logger.debug(`Navigating directly to product: ${productUrl}`)
        await page.goto(productUrl, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => null)
        await snap(page, '2-product')

        // Step 3: Find and click add-to-cart button
        // Try multiple selector patterns used by Shopify themes
        const addToCartSelectors = [
          'button[name="add"]',
          'button[data-add-to-cart]',
          'button:has-text("Add to cart")',
          'button:has-text("ADD TO CART")',
          'button:has-text("Add To Cart")',
          '[data-action="add-to-cart"]',
          'input[name="add"]',
          'button[type="submit"]:has-text("cart")',
        ]

        let addToCartBtn = null
        for (const sel of addToCartSelectors) {
          addToCartBtn = await page.$(sel)
          if (addToCartBtn) {
            const visible = await addToCartBtn.isVisible().catch(() => false)
            if (visible) break
            addToCartBtn = null
          }
        }

        // Click the button if we found one (mirrors a real user)…
        let addMethod: 'button' | 'api' | null = null
        if (addToCartBtn) {
          await addToCartBtn.scrollIntoViewIfNeeded().catch(() => null)
          await addToCartBtn.click({ force: true }).catch(() => null)
          await page.waitForTimeout(2500)
          logger.debug('Clicked add to cart')
        }

        // …then VERIFY via the Cart API — definitive, theme-agnostic
        let cart = await getCartState(page)
        if (addToCartBtn && cart && cart.item_count > 0) {
          addMethod = 'button'
        } else {
          // Button missing or click didn't register (variant pickers, drawer JS, etc.)
          // Fall back to the AJAX Cart API so the rest of the flow can still be tested.
          const added = await addViaCartApi(page, productHandle)
          if (added) {
            cart = await getCartState(page)
            if (cart && cart.item_count > 0) addMethod = 'api'
          }
        }

        if (!addToCartBtn) {
          findings.push({
            id: 'checkout-auto-no-add-button',
            severity: addMethod === 'api' ? 'medium' : 'high',
            title: 'Add to cart button not found on product page',
            description: `Could not locate the "Add to cart" button on ${productUrl}. Tried ${addToCartSelectors.length} selector patterns.${addMethod === 'api' ? ' However, the AJAX Cart API (/cart/add.js) works — the theme may use a non-standard button; verify manually.' : ''}`,
            recommendation: 'Verify theme has cart functionality enabled.',
          })
        } else if (addMethod === 'api') {
          findings.push({
            id: 'checkout-auto-button-click-ineffective',
            severity: 'medium',
            title: 'Add-to-cart button click did not update the cart',
            description: `Clicking the add-to-cart button on ${productUrl} did not increase /cart.js item_count (the Cart API itself works). This may indicate a JS error on the button, a required variant selection, or a broken cart drawer.`,
            recommendation: 'Test add-to-cart manually on the product page and check the browser console for JS errors.',
          })
        }

        if (!cart) {
          findings.push({
            id: 'checkout-auto-cart-unverifiable',
            severity: 'medium',
            title: 'Cart state could not be verified (/cart.js unreachable)',
            description: 'The Shopify AJAX Cart API did not respond, so cart contents could not be verified. This is usually bot protection or a password/redirect issue — not necessarily a broken cart.',
            recommendation: 'Verify the cart manually in a browser.',
          })
        } else if (cart.item_count === 0) {
          findings.push({
            id: 'checkout-auto-item-not-in-cart',
            severity: 'high',
            title: 'Item not in cart after add-to-cart (verified via /cart.js)',
            description: 'Both the add-to-cart button and the AJAX Cart API (/cart/add.js) failed to add an item — /cart.js reports item_count 0. This is a real cart failure, not a selector issue.',
            recommendation: 'Check theme cart implementation and product availability (inventory, variant availability).',
          })
        }

        // Step 4: Cart page screenshot (informational — cart state already verified via API)
        await page.goto(`${base}/cart`, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => null)
        await snap(page, '3-cart')

        if (cart && cart.item_count > 0) {
          // Step 5: Go to checkout DIRECTLY — /checkout works on every Shopify store
          // regardless of what the theme's cart button looks like.
          await page.goto(`${base}/checkout`, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => null)
          await page.waitForTimeout(4000)
          await snap(page, '4-checkout')

          const url: string = page.url()
          const reachedCheckout = /\/checkouts?\/|checkout\.shopify\.com/.test(url)
          const hitCheckpoint = /\/checkpoint|\/throttle|hcaptcha|challenge/i.test(url)

          if (!reachedCheckout) {
            findings.push({
              id: 'checkout-auto-unreachable',
              severity: hitCheckpoint ? 'medium' : 'critical',
              title: hitCheckpoint
                ? 'Checkout blocked by bot protection (unverifiable)'
                : 'Checkout page did not load',
              description: hitCheckpoint
                ? `Navigating to /checkout landed on a bot-protection page (${url}). Checkout could not be verified by automation — this does NOT mean checkout is broken.`
                : `Navigating to /checkout with ${cart.item_count} item(s) in cart landed on ${url} instead of a Shopify checkout URL.`,
              recommendation: hitCheckpoint
                ? 'Verify checkout manually in a browser.'
                : 'Verify checkout is enabled in store settings and the store plan supports checkout.',
            })
          } else {
            logger.debug('Reached Shopify checkout')
            const emailField = await page.$(
              'input[type="email"], input[name*="email"], #email, [aria-label*="email" i], input[autocomplete="email"]'
            )
            const addressField = await page.$(
              'input[name*="address"], input[name*="Address"], #address, [placeholder*="address" i], input[autocomplete*="address"]'
            )
            const paymentSection = await page.$(
              '[data-payment], [class*="payment"], button:has-text("PayPal"), button:has-text("Shop Pay"), [class*="card"], iframe[src*="card-fields"]'
            )

            // Only assert missing fields now that we KNOW we are on the checkout page.
            if (!emailField) {
              findings.push({
                id: 'checkout-auto-no-email-field',
                severity: 'high',
                title: 'Email field not found on checkout',
                description: `Reached Shopify checkout (${url}) but no email input was found in the Contact section.`,
              })
            }
            if (!addressField) {
              findings.push({
                id: 'checkout-auto-no-address-field',
                severity: 'medium',
                title: 'Address field not visible on checkout first step',
                description: `Reached Shopify checkout but no address input was visible. Note: multi-step checkouts show address on a later step — verify manually before treating as a defect.`,
              })
            }
            if (!paymentSection) {
              findings.push({
                id: 'checkout-auto-no-payment-section',
                severity: 'medium',
                title: 'Payment section not visible on checkout first step',
                description: 'No payment method UI was visible. Multi-step checkouts show payment on the final step — verify manually before treating as a defect.',
                recommendation: 'Confirm payment methods in Admin → Settings → Payments.',
              })
            }

            if (emailField && addressField && paymentSection) {
              findings.push({
                id: 'checkout-auto-flow-works',
                severity: 'info',
                title: 'Full checkout flow accessible',
                description: `Verified: /products/${productHandle} → add-to-cart (${addMethod}) → /cart.js item_count ${cart.item_count} → ${url} with contact, address, and payment sections visible.`,
              })
            } else if (emailField) {
              findings.push({
                id: 'checkout-auto-partial',
                severity: 'info',
                title: 'Checkout reached (first step verified)',
                description: `Checkout loaded at ${url} with the contact step visible. Address/payment steps not visible on the first page (normal for multi-step checkout).`,
              })
            }
          }
        }
      }
    } finally {
      await page.close().catch(() => null)
    }

    if (findings.length === 0) {
      findings.push({
        id: 'checkout-auto-complete',
        severity: 'info',
        title: 'Automated checkout test completed',
        description: 'Store checkout flow is accessible and functional.',
      })
    }
  } catch (err: any) {
    logger.debug(`Checkout automated test error: ${err.message}`)
    findings.push({
      id: 'checkout-auto-error',
      severity: 'high',
      title: 'Checkout test failed',
      description: `Browser test error: ${err.message}`,
      recommendation: 'Verify store is accessible and checkout is enabled.',
    })
  } finally {
    if (owned && session) await session.close()
  }

  return {
    id: 'shopify-checkout',
    name: 'Shopify Checkout',
    status: findings.some((f) => f.severity === 'critical') ? 'fail' : findings.some((f) => f.severity === 'high') ? 'warning' : 'pass',
    duration_ms: Date.now() - startTime,
    findings,
  }
}
