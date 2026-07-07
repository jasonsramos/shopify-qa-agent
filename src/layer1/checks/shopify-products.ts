import { SiteConfig, ShopifyProductsCheckResult, Finding } from '../../types.js'
import { ShopifyAdminClient } from '../../shopify-api.js'
import { logger } from '../../utils.js'

export async function runShopifyProductsCheck(config: SiteConfig): Promise<ShopifyProductsCheckResult> {
  const startTime = Date.now()
  const findings: Finding[] = []

  // If no token, skip API checks
  if (!config.admin_access_token) {
    findings.push({
      id: 'products-check-requires-token',
      severity: 'info',
      title: 'Product audit requires Admin API token',
      description: 'Detailed product checks are skipped without admin credentials.',
    })

    return {
      id: 'shopify-products',
      name: 'Shopify Products Check',
      status: 'skipped',
      duration_ms: Date.now() - startTime,
      findings,
      products_total: 0,
      products_active: 0,
      products_without_images: 0,
      products_without_description: 0,
      products_with_schema_markup: 0,
      issues: [],
    }
  }

  try {
    const client = new ShopifyAdminClient(config)

    // Fetch product counts
    const totalProducts = await client.getProductCount()
    const productsNoImages = await client.getProductsWithoutImages()
    const productsNoDescriptions = await client.getProductsWithoutDescriptions()

    logger.debug(`Total products: ${totalProducts}, No images: ${productsNoImages}, No descriptions: ${productsNoDescriptions}`)

    // Check for missing images
    if (productsNoImages > 0) {
      findings.push({
        id: 'products-missing-images',
        severity: 'medium',
        title: `${productsNoImages} products missing images in Admin`,
        description: `${productsNoImages} out of ${totalProducts} products (${((productsNoImages / totalProducts) * 100).toFixed(1)}%) have no image uploaded in Shopify Admin. Note: the theme may show a placeholder on the storefront — verify visually before acting on this.`,
        recommendation: 'Add product images via Shopify Admin → Products. Use high-quality, consistent image sizes.',
      })
    }

    // Check for missing descriptions
    if (productsNoDescriptions > 0) {
      findings.push({
        id: 'products-missing-descriptions',
        severity: productsNoDescriptions > totalProducts * 0.1 ? 'medium' : 'low',
        title: `${productsNoDescriptions} products missing descriptions`,
        description: `${productsNoDescriptions} products lack descriptions. This impacts SEO and customer understanding.`,
        recommendation: 'Add descriptive text to all products to improve SEO and customer trust.',
      })
    }

    // Warn if very few products
    if (totalProducts < 5 && totalProducts > 0) {
      findings.push({
        id: 'products-very-few',
        severity: 'info',
        title: 'Store has very few products',
        description: `Only ${totalProducts} products found. Ensure you have added all your products before launch.`,
      })
    }

    if (totalProducts === 0) {
      findings.push({
        id: 'products-none',
        severity: 'critical',
        title: 'No products found in store',
        description: 'Your store has no products. Customers cannot purchase anything.',
        recommendation: 'Add products to your store via Shopify Admin.',
      })
    }

    return {
      id: 'shopify-products',
      name: 'Shopify Products Check',
      status: findings.some((f) => f.severity === 'critical') ? 'fail' : findings.length > 0 ? 'warning' : 'pass',
      duration_ms: Date.now() - startTime,
      findings,
      products_total: totalProducts,
      products_active: totalProducts,
      products_without_images: productsNoImages,
      products_without_description: productsNoDescriptions,
      products_with_schema_markup: 0,
      issues: findings,
    }
  } catch (err: any) {
    logger.debug(`Product check error: ${err.message}`)
    findings.push({
      id: 'products-check-error',
      severity: 'high',
      title: 'Product audit failed',
      description: `Could not fetch product data: ${err.message}`,
      recommendation: 'Verify your Admin API token has product read permissions.',
    })

    return {
      id: 'shopify-products',
      name: 'Shopify Products Check',
      status: 'fail',
      duration_ms: Date.now() - startTime,
      findings,
      products_total: 0,
      products_active: 0,
      products_without_images: 0,
      products_without_description: 0,
      products_with_schema_markup: 0,
      issues: findings,
    }
  }
}
