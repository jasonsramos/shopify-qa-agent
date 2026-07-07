import { SiteConfig, CheckResult, Finding } from '../../types.js'
import { ShopifyAdminClient } from '../../shopify-api.js'
import { logger } from '../../utils.js'

export async function runShopifyProductsDeepCheck(config: SiteConfig): Promise<CheckResult> {
  const startTime = Date.now()
  const findings: Finding[] = []

  try {
    const api = new ShopifyAdminClient(config)
    const products = await api.getProductsForAudit()

    if (products.length === 0) {
      findings.push({
        id: 'products-deep-no-products',
        severity: 'critical',
        title: 'No products found in store',
        description: 'Admin API returned 0 products. Store may not have any products configured.',
        recommendation: 'Add products via Shopify Admin.',
      })
      return {
        id: 'shopify-products-deep',
        name: 'Shopify Products Deep Check',
        status: 'fail',
        duration_ms: Date.now() - startTime,
        findings,
      }
    }

    const issuesByProduct: { [key: string]: string[] } = {}

    for (const product of products) {
      const issues: string[] = []

      if (!product.images?.edges?.length) issues.push('no images')
      if (!product.descriptionHtml || product.descriptionHtml.replace(/<[^>]*>/g, '').trim().length < 20) {
        issues.push('missing/short description')
      }

      const variants = (product.variants?.edges || []).map((e: any) => e.node)
      if (!variants.length) {
        issues.push('no variants')
      } else {
        for (const v of variants) {
          if (!v.price || parseFloat(v.price) === 0) issues.push(`variant "${v.title}" has $0 price`)
          if (!v.availableForSale && v.inventoryQuantity === 0) issues.push(`variant "${v.title}" out of stock`)
        }
      }

      if (!product.title || product.title.trim().length < 3) issues.push('invalid title')
      if (product.title.toLowerCase().includes('test') || product.title.toLowerCase().includes('example')) {
        issues.push('placeholder product name')
      }

      if (issues.length > 0) issuesByProduct[product.title] = issues
    }

    const productsWithIssues = Object.keys(issuesByProduct).length
    if (productsWithIssues > 0) {
      const severity = productsWithIssues > products.length * 0.3 ? 'high' : 'medium'
      findings.push({
        id: 'products-deep-quality-issues',
        severity,
        title: `${productsWithIssues}/${products.length} sampled products have data issues`,
        description: `Found ${productsWithIssues} products with missing/invalid data: ${Object.entries(issuesByProduct)
          .slice(0, 3)
          .map(([name, issues]) => `"${name}" (${issues.join(', ')})`)
          .join('; ')}${productsWithIssues > 3 ? '...' : ''}`,
        recommendation: 'Complete product data: add images, descriptions, set correct prices, publish variants.',
      })
    }

    if (findings.length === 0) {
      findings.push({
        id: 'products-deep-good',
        severity: 'info',
        title: `Product data quality looks good (checked ${products.length} products)`,
        description: `Sampled ${products.length} products. All have images, descriptions, prices, and variants configured.`,
      })
    }

    return {
      id: 'shopify-products-deep',
      name: 'Shopify Products Deep Check',
      status: findings.some((f) => f.severity === 'critical') ? 'fail' : findings.some((f) => f.severity === 'high') ? 'warning' : 'pass',
      duration_ms: Date.now() - startTime,
      findings,
    }
  } catch (err: any) {
    logger.debug(`Products deep check error: ${err.message}`)
    findings.push({
      id: 'products-deep-error',
      severity: 'high',
      title: 'Product data check failed',
      description: `Could not fetch product data via Admin API: ${err.message}`,
      recommendation: 'Verify your Admin API token has read_products scope.',
    })
    return {
      id: 'shopify-products-deep',
      name: 'Shopify Products Deep Check',
      status: 'fail',
      duration_ms: Date.now() - startTime,
      findings,
    }
  }
}
