import { SiteConfig, CheckResult, Finding } from '../../types.js'
import { ShopifyAdminClient } from '../../shopify-api.js'
import { logger } from '../../utils.js'

export async function runShopifyStoreConfigCheck(config: SiteConfig): Promise<CheckResult> {
  const startTime = Date.now()
  const findings: Finding[] = []

  if (!config.admin_access_token) {
    findings.push({
      id: 'no-admin-token',
      severity: 'info',
      title: 'Admin API token not configured',
      description: 'Store config check requires admin_access_token.',
    })

    return {
      id: 'shopify-store-config',
      name: 'Shopify Store Config',
      status: 'pass',
      duration_ms: Date.now() - startTime,
      findings,
      store_info: {
        id: '',
        name: config.name,
        domain: config.store_domain,
        plan: config.store_plan,
        currency: '',
        timezone: '',
        country_code: '',
        created_at: '',
      },
      theme_info: {
        id: config.theme_id || '',
        name: config.theme_name || '',
        role: 'main',
        created_at: '',
        updated_at: '',
      },
      payment_methods: [],
      shipping_zones: 0,
      sales_channels_active: [],
      issues: findings,
    } as any
  }

  try {
    const client = new ShopifyAdminClient(config)
    logger.debug('Fetching store configuration from Shopify Admin API')

    const [shopInfo, theme, paymentMethods, checkoutConfig] = await Promise.all([
      client.getShopInfo(),
      client.getActiveTheme(),
      client.getPaymentMethods(),
      client.getCheckoutConfig(),
    ])

    // Validate store configuration
    if (checkoutConfig.paymentGateways !== null && checkoutConfig.paymentGateways.length === 0) {
      findings.push({
        id: 'no-payment-gateway',
        severity: 'critical',
        title: 'No payment gateway configured',
        description: 'Customers cannot pay without a payment gateway.',
        recommendation: 'Configure Shopify Payments or another payment provider in Admin.',
      })
    }

    if (checkoutConfig.shippingZones === 0) {
      findings.push({
        id: 'no-shipping-zones',
        severity: 'high',
        title: 'No shipping zones configured',
        description: 'Customers cannot calculate shipping costs.',
        recommendation: 'Configure shipping zones in Admin → Settings → Shipping.',
      })
    }

    return {
      id: 'shopify-store-config',
      name: 'Shopify Store Config',
      status: findings.filter((f) => f.severity === 'critical').length > 0 ? 'fail' : findings.length > 0 ? 'warning' : 'pass',
      duration_ms: Date.now() - startTime,
      findings,
      store_info: shopInfo,
      theme_info: theme,
      payment_methods: paymentMethods,
      shipping_zones: checkoutConfig.shippingZones,
      sales_channels_active: ['Online Store'],
      issues: findings,
    } as any
  } catch (err: any) {
    logger.debug(`Store config check failed: ${err.message}`)

    findings.push({
      id: 'config-check-failed',
      severity: 'info',
      title: 'Could not fetch store config via Admin API',
      description: `Error: ${err.message}`,
      recommendation: 'Verify admin_access_token is valid.',
    })

    return {
      id: 'shopify-store-config',
      name: 'Shopify Store Config',
      status: 'pass',
      duration_ms: Date.now() - startTime,
      findings,
      store_info: {
        id: '',
        name: config.name,
        domain: config.store_domain,
        plan: config.store_plan,
        currency: '',
        timezone: '',
        country_code: '',
        created_at: '',
      },
      theme_info: {
        id: config.theme_id || '',
        name: config.theme_name || '',
        role: 'main',
        created_at: '',
        updated_at: '',
      },
      payment_methods: [],
      shipping_zones: 0,
      sales_channels_active: [],
      issues: findings,
    } as any
  }
}
