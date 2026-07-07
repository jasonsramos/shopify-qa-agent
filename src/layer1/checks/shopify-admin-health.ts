import { SiteConfig, CheckResult, Finding } from '../../types.js'
import { ShopifyAdminClient } from '../../shopify-api.js'
import { baseUrl, secureFetch, logger } from '../../utils.js'

export async function runShopifyAdminHealthCheck(config: SiteConfig): Promise<CheckResult> {
  const startTime = Date.now()
  const findings: Finding[] = []

  if (!config.admin_access_token) {
    findings.push({
      id: 'admin-health-requires-token',
      severity: 'info',
      title: 'Admin health check requires API token',
      description: 'Store configuration details require admin credentials.',
    })

    return {
      id: 'shopify-admin-health',
      name: 'Shopify Admin Health',
      status: 'skipped',
      duration_ms: Date.now() - startTime,
      findings,
    }
  }

  try {
    const client = new ShopifyAdminClient(config)

    // Check API connectivity
    let apiHealthy = true
    try {
      const shopInfo = await client.getShopInfo()
      logger.debug(`Shop API healthy: ${shopInfo.name}`)
    } catch (err: any) {
      apiHealthy = false
      findings.push({
        id: 'admin-api-unreachable',
        severity: 'critical',
        title: 'Shopify Admin API unreachable',
        description: `Cannot connect to Admin API: ${err.message}`,
        recommendation: 'Verify your access token is valid and has required scopes.',
      })
    }

    if (!apiHealthy) {
      return {
        id: 'shopify-admin-health',
        name: 'Shopify Admin Health',
        status: 'fail',
        duration_ms: Date.now() - startTime,
        findings,
      }
    }

    // Check HTTPS
    const base = baseUrl(config.store_url)
    if (!config.store_url.startsWith('https://')) {
      findings.push({
        id: 'admin-http-not-https',
        severity: 'critical',
        title: 'Store URL is not HTTPS',
        description: 'Store URL should use HTTPS for security.',
        recommendation: 'Ensure store URL uses https:// protocol.',
      })
    }

    // Check SSL
    try {
      const response = await secureFetch(base, { timeout: 5000 })
      if (!response.ok) {
        findings.push({
          id: 'admin-ssl-check-failed',
          severity: 'high',
          title: 'SSL certificate check failed',
          description: `Store returned HTTP ${response.status}`,
          recommendation: 'Verify SSL certificate is valid and properly configured.',
        })
      }
    } catch (err: any) {
      findings.push({
        id: 'admin-ssl-unreachable',
        severity: 'high',
        title: 'Store is unreachable',
        description: `Cannot reach store: ${err.message}`,
        recommendation: 'Verify store URL is correct and store is published.',
      })
    }

    // Check checkout config
    try {
      const config_data = await client.getCheckoutConfig()

      if (!config_data.created) {
        findings.push({
          id: 'admin-checkout-misconfigured',
          severity: 'critical',
          title: 'Checkout not properly configured',
          description: 'Shopify checkout is not functional.',
          recommendation: 'Enable checkout in Shopify Admin → Settings → Checkout.',
        })
      }

      if (config_data.paymentGateways !== null && config_data.paymentGateways.length === 0) {
        findings.push({
          id: 'admin-no-payment-gateways',
          severity: 'critical',
          title: 'No payment gateways configured',
          description: 'Store has no payment methods enabled. Customers cannot pay.',
          recommendation: 'Configure payment methods in Admin → Settings → Payment methods.',
        })
      }

      if (config_data.shippingZones === 0) {
        findings.push({
          id: 'admin-no-shipping-zones',
          severity: 'high',
          title: 'No shipping zones configured',
          description: 'Store has no shipping rates. Digital products only stores can ignore this.',
          recommendation: 'Configure shipping in Admin → Settings → Shipping and delivery.',
        })
      }
    } catch (err: any) {
      logger.debug(`Checkout config check failed: ${err.message}`)
    }

    // Check payment methods
    try {
      const wallets = await client.getPaymentMethods()
      if (wallets !== null && wallets.length === 0) {
        findings.push({
          id: 'admin-no-digital-wallets',
          severity: 'low',
          title: 'No digital wallet payment methods enabled',
          description: 'Shop does not support Apple Pay, Google Pay, or Shop Pay.',
          recommendation: 'Enable digital wallets to improve checkout conversion. See Admin → Settings → Checkout.',
        })
      }
    } catch (err: any) {
      logger.debug(`Payment methods check failed: ${err.message}`)
    }

    // Check apps
    try {
      const apps = await client.getInstalledApps()
      if (apps.length === 0) {
        findings.push({
          id: 'admin-no-apps',
          severity: 'info',
          title: 'No apps installed',
          description: 'Your store has no third-party apps installed. This is fine if you have all needed features built-in.',
        })
      }
    } catch (err: any) {
      logger.debug(`Apps check failed: ${err.message}`)
    }

    if (findings.length === 0) {
      findings.push({
        id: 'admin-health-good',
        severity: 'info',
        title: 'Admin configuration looks healthy',
        description: 'Shopify Admin API is accessible and store is properly configured.',
      })
    }

    return {
      id: 'shopify-admin-health',
      name: 'Shopify Admin Health',
      status: findings.some((f) => f.severity === 'critical') ? 'fail' : findings.some((f) => f.severity === 'high') ? 'warning' : 'pass',
      duration_ms: Date.now() - startTime,
      findings,
    }
  } catch (err: any) {
    logger.debug(`Admin health check error: ${err.message}`)
    findings.push({
      id: 'admin-health-check-error',
      severity: 'high',
      title: 'Admin health check failed',
      description: `Could not complete check: ${err.message}`,
    })

    return {
      id: 'shopify-admin-health',
      name: 'Shopify Admin Health',
      status: 'fail',
      duration_ms: Date.now() - startTime,
      findings,
    }
  }
}
