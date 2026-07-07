import axios from 'axios'
import { SiteConfig, ShopInfo, Theme, ShopifyApp } from './types.js'
import { logger } from './utils.js'

/**
 * Shopify Admin API Client
 * Handles GraphQL queries to Shopify Admin API
 */
export class ShopifyAdminClient {
  private accessToken: string
  private storeDomain: string
  private apiVersion = '2024-10'

  constructor(config: SiteConfig) {
    if (!config.admin_access_token) {
      throw new Error('admin_access_token required for Shopify API')
    }
    this.accessToken = config.admin_access_token
    this.storeDomain = config.store_domain
  }

  /**
   * Execute a GraphQL query with retry logic
   */
  private async query<T>(query: string, variables?: Record<string, any>): Promise<T> {
    const url = `https://${this.storeDomain}/admin/api/${this.apiVersion}/graphql.json`
    const maxRetries = 3
    let lastError: Error | null = null

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const response = await axios.post(
          url,
          { query, variables },
          {
            headers: {
              'X-Shopify-Access-Token': this.accessToken,
              'Content-Type': 'application/json',
            },
            timeout: 15000,
          }
        )

        if (response.data.errors) {
          throw new Error(`GraphQL Error: ${response.data.errors[0]?.message}`)
        }

        return response.data.data as T
      } catch (err: any) {
        lastError = err

        // Check if error is retryable
        const isRetryable =
          err.code === 'ECONNRESET' ||
          err.code === 'ETIMEDOUT' ||
          err.code === 'ENOTFOUND' ||
          (err.response && err.response.status >= 500) ||
          (err.response && err.response.status === 429) // Rate limited

        if (!isRetryable || attempt === maxRetries) {
          logger.debug(`Shopify API Error (attempt ${attempt}/${maxRetries}): ${err.message}`)
          throw err
        }

        // Exponential backoff: 1s, 2s, 4s
        const delayMs = Math.pow(2, attempt - 1) * 1000
        logger.debug(`API retry ${attempt}/${maxRetries} after ${delayMs}ms: ${err.message}`)
        await new Promise((resolve) => setTimeout(resolve, delayMs))
      }
    }

    throw lastError || new Error('Unknown API error')
  }

  /**
   * Get shop information
   */
  async getShopInfo(): Promise<ShopInfo> {
    const query = `
      query {
        shop {
          id
          name
          url
          plan {
            displayName
          }
          currencyCode
          billingAddress {
            countryCode
          }
          createdAt
        }
      }
    `

    const result = await this.query<{ shop: any }>(query)

    return {
      id: result.shop.id,
      name: result.shop.name,
      domain: this.storeDomain,
      plan: result.shop.plan.displayName,
      currency: result.shop.currencyCode,
      timezone: '',
      country_code: result.shop.billingAddress?.countryCode ?? '',
      created_at: result.shop.createdAt,
    }
  }

  /**
   * Get current active theme
   */
  async getActiveTheme(): Promise<Theme> {
    const query = `
      query {
        themes(first: 1, roles: MAIN) {
          edges {
            node {
              id
              name
              role
              createdAt
              updatedAt
            }
          }
        }
      }
    `

    const result = await this.query<{ themes: any }>(query)

    if (result.themes.edges.length === 0) {
      throw new Error('No active theme found')
    }

    const theme = result.themes.edges[0].node
    return {
      id: theme.id.split('/').pop(),
      name: theme.name,
      role: theme.role.toLowerCase(),
      created_at: theme.createdAt,
      updated_at: theme.updatedAt,
    }
  }

  /**
   * Get installed apps
   */
  async getInstalledApps(): Promise<ShopifyApp[]> {
    const query = `
      query {
        appInstallations(first: 100) {
          edges {
            node {
              app {
                id
                title
                handle
              }
            }
          }
        }
      }
    `

    const result = await this.query<{ appInstallations: any }>(query)

    return result.appInstallations.edges.map((edge: any) => ({
      id: edge.node.app.id,
      title: edge.node.app.title,
      handle: edge.node.app.handle,
      category: edge.node.app.handle || 'Unknown',
      status: 'installed' as const,
      installed_date: new Date().toISOString(),
    }))
  }

  /**
   * Get payment gateway configurations via GraphQL paymentSettings.
   * Returns null when the API cannot confirm gateway status (avoids false-positive "no payment" alerts).
   */
  async getPaymentMethods(): Promise<string[] | null> {
    try {
      const result = await this.query<{ shop: any }>(`
        query {
          shop {
            paymentSettings {
              supportedDigitalWallets
            }
          }
        }
      `)
      const settings = result?.shop?.paymentSettings
      if (!settings) return null

      const methods: string[] = [
        ...(settings.supportedDigitalWallets || []),
      ]
      return methods.length > 0 ? methods : null
    } catch (err: any) {
      // Try REST fallback
      try {
        const url = `https://${this.storeDomain}/admin/api/${this.apiVersion}/payment_gateways.json`
        const response = await axios.get(url, {
          headers: { 'X-Shopify-Access-Token': this.accessToken },
          timeout: 10000,
        })
        const gateways = response.data.payment_gateways || []
        return gateways.map((g: any) => g.provider_name || g.name || 'Unknown')
      } catch {
        logger.debug(`Could not determine payment gateways: ${err.message}`)
        return null  // null = unknown, not "no gateways"
      }
    }
  }

  /**
   * Get first 20 products with quality-audit fields
   */
  /**
   * Get the first published product's handle for direct URL navigation in tests.
   */
  async getFirstProductHandle(): Promise<string | null> {
    try {
      const result = await this.query<{ products: any }>(`
        query {
          products(first: 5, query: "status:active") {
            edges {
              node {
                handle
                variants(first: 1) { edges { node { id } } }
              }
            }
          }
        }
      `)
      const edges = result.products?.edges || []
      for (const edge of edges) {
        if (edge.node.variants?.edges?.length > 0) return edge.node.handle
      }
      return edges[0]?.node?.handle || null
    } catch {
      return null
    }
  }

  async getProductsForAudit(): Promise<any[]> {
    const result = await this.query<{ products: any }>(`
      query {
        products(first: 20) {
          edges {
            node {
              id
              title
              descriptionHtml
              status
              images(first: 1) { edges { node { url } } }
              variants(first: 10) {
                edges {
                  node {
                    id
                    title
                    price
                    inventoryQuantity
                    availableForSale
                  }
                }
              }
            }
          }
        }
      }
    `)
    return (result.products?.edges || []).map((e: any) => e.node)
  }

  /**
   * Get product count
   */
  async getProductCount(): Promise<number> {
    const query = `
      query {
        products(first: 250) {
          edges {
            node {
              id
            }
          }
        }
      }
    `

    try {
      const result = await this.query<{ products: any }>(query)
      return result.products?.edges?.length || 0
    } catch {
      return 0
    }
  }

  /**
   * Get products without images
   */
  async getProductsWithoutImages(): Promise<number> {
    const query = `
      query {
        products(first: 50, query: "image_count:0") {
          edges {
            node {
              id
            }
          }
        }
      }
    `

    try {
      const result = await this.query<{ products: any }>(query)
      return result.products?.edges?.length || 0
    } catch {
      return 0
    }
  }

  /**
   * Get checkout configuration
   */
  async getCheckoutConfig(): Promise<{
    created: boolean
    paymentGateways: string[] | null  // null = API could not confirm
    shippingZones: number
  }> {
    try {
      const [paymentGateways, shippingResult] = await Promise.all([
        this.getPaymentMethods(),
        this.query<{ deliveryProfiles: any }>(`
          query {
            deliveryProfiles(first: 10) {
              edges {
                node {
                  id
                }
              }
            }
          }
        `),
      ])

      return {
        created: true,
        paymentGateways,
        shippingZones: shippingResult.deliveryProfiles?.edges?.length || 0,
      }
    } catch {
      return {
        created: false,
        paymentGateways: null,
        shippingZones: 0,
      }
    }
  }

  /**
   * Get products without descriptions
   */
  async getProductsWithoutDescriptions(): Promise<number> {
    const query = `
      query {
        products(first: 50, query: "body_html:\"\"") {
          edges {
            node {
              id
            }
          }
        }
      }
    `

    try {
      const result = await this.query<{ products: any }>(query)
      return result.products?.edges?.length || 0
    } catch {
      return 0
    }
  }

  /**
   * Get all collections
   */
  async getCollections(): Promise<Array<{ id: string; title: string; productCount: number }>> {
    const query = `
      query {
        collections(first: 50) {
          edges {
            node {
              id
              title
              products(first: 1) {
                edges {
                  node {
                    id
                  }
                }
              }
            }
          }
        }
      }
    `

    try {
      const result = await this.query<{ collections: any }>(query)
      return result.collections.edges.map((edge: any) => ({
        id: edge.node.id.split('/').pop(),
        title: edge.node.title,
        productCount: edge.node.products?.edges?.length || 0,
      }))
    } catch {
      return []
    }
  }

  /**
   * Get theme assets (REST call, not GraphQL)
   */
  async getThemeAssets(themeId: string): Promise<Array<{ key: string; size?: number }>> {
    const url = `https://${this.storeDomain}/admin/api/${this.apiVersion}/themes/${themeId}/assets.json`

    try {
      const response = await axios.get(url, {
        headers: {
          'X-Shopify-Access-Token': this.accessToken,
        },
        timeout: 15000,
      })

      if (!response.data.assets) {
        return []
      }

      return response.data.assets.map((asset: any) => ({
        key: asset.key,
        size: asset.size,
      }))
    } catch (err: any) {
      logger.debug(`Failed to fetch theme assets: ${err.message}`)
      return []
    }
  }
}

/**
 * Known app conflicts (apps that don't work well together)
 */
export const KNOWN_APP_CONFLICTS = [
  {
    app1: 'Recharge',
    app2: 'Bold Subscriptions',
    issue: 'Both manage subscriptions - may cause conflicts',
    severity: 'critical' as const,
  },
  {
    app1: 'Klaviyo',
    app2: 'Mailchimp',
    issue: 'Both manage email marketing - duplicate integrations',
    severity: 'high' as const,
  },
  {
    app1: 'ShipStation',
    app2: 'Printful',
    issue: 'Both integrate with fulfillment - may cause order duplication',
    severity: 'high' as const,
  },
]

/**
 * Critical apps that should be tested thoroughly
 */
export const CRITICAL_APPS = ['Recharge', 'Stripe', 'Shopify Payments', 'Klaviyo', 'ShipStation', 'Gorgias']

/**
 * Detect known app conflicts
 */
export function detectAppConflicts(installedApps: ShopifyApp[]): Array<{
  app1: string
  app2: string
  issue: string
  severity: 'critical' | 'high' | 'medium'
}> {
  const conflicts = []
  const appTitles = installedApps.map((a) => a.title)

  for (const conflict of KNOWN_APP_CONFLICTS) {
    if (appTitles.includes(conflict.app1) && appTitles.includes(conflict.app2)) {
      conflicts.push(conflict)
    }
  }

  return conflicts
}

/**
 * Check for missing critical apps
 */
export function checkMissingCriticalApps(
  installedApps: ShopifyApp[],
  criticalAppsRequired: string[]
): string[] {
  const appTitles = installedApps.map((a) => a.title)
  return criticalAppsRequired.filter((app) => !appTitles.includes(app))
}
