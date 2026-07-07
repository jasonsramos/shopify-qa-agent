import { SiteConfig, CheckResult, Finding } from '../../types.js'
import { ShopifyAdminClient } from '../../shopify-api.js'
import { logger } from '../../utils.js'

export async function runShopifyContentQualityCheck(config: SiteConfig): Promise<CheckResult> {
  const startTime = Date.now()
  const findings: Finding[] = []

  if (!config.admin_access_token) {
    findings.push({
      id: 'content-quality-requires-token',
      severity: 'info',
      title: 'Content quality check requires Admin API token',
      description: 'Detailed content analysis is skipped without admin credentials.',
    })

    return {
      id: 'shopify-content-quality',
      name: 'Shopify Content Quality',
      status: 'skipped',
      duration_ms: Date.now() - startTime,
      findings,
    }
  }

  try {
    const client = new ShopifyAdminClient(config)

    // Get products
    const totalProducts = await client.getProductCount()
    const collections = await client.getCollections()

    logger.debug(`Content quality: ${totalProducts} products, ${collections.length} collections`)

    // Check for placeholder product handles
    // This is limited without full product list, so we warn about the limitation
    if (totalProducts > 0) {
      findings.push({
        id: 'content-quality-placeholder-warning',
        severity: 'info',
        title: 'Content quality check (limited)',
        description: 'Full product handle analysis requires deeper inspection. Check Admin → Products for handles like "test-product", "example", "product-1".',
      })
    }

    // Check for empty collections
    const emptyCollections = collections.filter((c) => c.productCount === 0)
    if (emptyCollections.length > 0) {
      findings.push({
        id: 'content-quality-empty-collections',
        severity: 'medium',
        title: `${emptyCollections.length} empty collection(s) found`,
        description: `Collections with 0 products: ${emptyCollections.map((c) => c.title).join(', ')}. Empty collections provide poor user experience.`,
        recommendation: 'Add products to these collections or remove them. Go to Admin → Products → Collections.',
      })
    }

    // Check for very small catalog
    if (totalProducts > 0 && totalProducts < 10) {
      findings.push({
        id: 'content-quality-small-catalog',
        severity: 'low',
        title: `Very small product catalog (${totalProducts} products)`,
        description: `Only ${totalProducts} products found. Ensure you have added all products before launch.`,
      })
    }

    // Check collection to product ratio
    const avgProductsPerCollection = totalProducts > 0 && collections.length > 0 ? totalProducts / collections.length : 0
    if (collections.length > totalProducts && collections.length > 3) {
      findings.push({
        id: 'content-quality-too-many-collections',
        severity: 'low',
        title: `More collections (${collections.length}) than products (${totalProducts})`,
        description: 'You have many collections but few products. This can confuse navigation.',
        recommendation: 'Consolidate collections or add more products to fill them.',
      })
    }

    // Check for collection organization
    if (collections.length > 0) {
      const wellFilledCollections = collections.filter((c) => c.productCount >= 5)
      if (wellFilledCollections.length < collections.length * 0.5) {
        findings.push({
          id: 'content-quality-sparse-collections',
          severity: 'low',
          title: `Collections are sparsely filled`,
          description: `Only ${wellFilledCollections.length}/${collections.length} collections have 5+ products. This makes browsing difficult.`,
          recommendation: 'Add more products to collections or reduce number of collections.',
        })
      }
    }

    if (findings.length === 0) {
      findings.push({
        id: 'content-quality-good',
        severity: 'info',
        title: 'Content organization looks healthy',
        description: `${totalProducts} products organized into ${collections.length} collections.`,
      })
    }

    return {
      id: 'shopify-content-quality',
      name: 'Shopify Content Quality',
      status: findings.some((f) => f.severity === 'high') ? 'fail' : findings.some((f) => f.severity === 'medium') ? 'warning' : 'pass',
      duration_ms: Date.now() - startTime,
      findings,
    }
  } catch (err: any) {
    logger.debug(`Content quality check error: ${err.message}`)
    findings.push({
      id: 'content-quality-error',
      severity: 'high',
      title: 'Content quality check failed',
      description: `Could not check content: ${err.message}`,
    })

    return {
      id: 'shopify-content-quality',
      name: 'Shopify Content Quality',
      status: 'fail',
      duration_ms: Date.now() - startTime,
      findings,
    }
  }
}
