import { SiteConfig, Layer1Results, CheckResult } from '../types.js'
import { runSecurityCheck } from './checks/security.js'
import { runPerformanceCheck } from './checks/performance.js'
import { runAccessibilityCheck } from './checks/accessibility.js'
import { runSeoCheck } from './checks/seo.js'
import { runPageHealthCheck } from './checks/page-health.js'
import { runBrokenLinksCheck } from './checks/broken-links.js'
import { runImageAuditCheck } from './checks/image-audit.js'
import { runFormAuditCheck } from './checks/form-audit.js'
import { runShopifyThemeCheck } from './checks/shopify-theme.js'
import { runShopifyAppsCheck } from './checks/shopify-apps.js'
import { runShopifyStoreConfigCheck } from './checks/shopify-store-config.js'
import { runShopifyProductsCheck } from './checks/shopify-products.js'
import { runShopifyAdminHealthCheck } from './checks/shopify-admin-health.js'
import { runShopifyLiquidAnalysisCheck } from './checks/shopify-liquid-analysis.js'
import { runShopifyAnalyticsCheck } from './checks/shopify-analytics.js'
import { runShopifyContentQualityCheck } from './checks/shopify-content-quality.js'
import { runShopifyMarketsCheck } from './checks/shopify-markets.js'
import { runShopifyProductsDeepCheck } from './checks/shopify-products-deep.js'
import { runShopifyCheckoutAutomatedCheck } from './checks/shopify-checkout-automated.js'
import { runShopifyCodeReviewCheck } from './checks/shopify-code-review.js'
import { runShopifyCodeAnalysisCheck } from './checks/shopify-code-analysis.js'
import { runResponsiveTestingCheck } from './checks/responsive-testing.js'
import { runFormCroScoringCheck } from './checks/form-cro-scoring.js'
import { runMultiLanguageDetectionCheck } from './checks/multi-language-detection.js'
import { runConsoleNetworkErrorsCheck } from './checks/console-network-errors.js'
import { runSiteWideScanCheck } from './checks/site-wide-scan.js'
import { runTemplateUiHealthCheck } from './checks/template-ui-health.js'
import { BrowserSession } from './browser-session.js'
import { timestamp, logger } from '../utils.js'
import * as fs from 'fs/promises'
import path from 'path'

/**
 * Run all Layer 1 checks in sequential order
 */
export async function runLayer1(config: SiteConfig, outputDir: string): Promise<Layer1Results> {
  const startTime = Date.now()

  logger.info(`🚀 Starting Layer 1 QA audit for ${config.store_domain}`)
  logger.dim(`Store: ${config.name || config.store_domain} | Plan: ${config.store_plan} | URL: ${config.store_url}`)

  // Create screenshots directory
  const screenshotsDir = path.join(outputDir, 'screenshots')
  await fs.mkdir(screenshotsDir, { recursive: true })

  const results: CheckResult[] = []
  const errors: { check: string; error: string }[] = []

  // Shared browser session — launched once, reused by every browser-based check.
  const session = new BrowserSession(config)
  try {
    await session.init()
  } catch (err: any) {
    logger.warn(`Could not start shared browser session: ${err.message}. Browser checks will self-launch.`)
  }

  // ── Check definitions ────────────────────────────────────────────────────
  // `browser: true` → runs in the shared-session group (sequential, one context).
  // others → API/network checks, run concurrently in batches.
  interface CheckDef {
    name: string
    fn: (session: BrowserSession) => Promise<CheckResult>
    browser?: boolean
    timeout?: number
  }

  const checks: CheckDef[] = [
    { name: 'Security', fn: (s) => runSecurityCheck(config, s), browser: true, timeout: 45000 },
    { name: 'Performance', fn: (s) => runPerformanceCheck(config, s), browser: true, timeout: 60000 },
    { name: 'Console & Network Errors', fn: (s) => runConsoleNetworkErrorsCheck(config, s), browser: true, timeout: 60000 },
    { name: 'Accessibility', fn: (s) => runAccessibilityCheck(config, s), browser: true, timeout: 60000 },
    { name: 'Shopify Checkout', fn: (s) => runShopifyCheckoutAutomatedCheck(config, screenshotsDir, s), browser: true, timeout: 90000 },
    { name: 'Responsive Testing', fn: (s) => runResponsiveTestingCheck(config, screenshotsDir, s), browser: true, timeout: 90000 },
    { name: 'Form Audit', fn: (s) => runFormAuditCheck(config, s), browser: true, timeout: 60000 },
    { name: 'Form CRO Scoring', fn: (s) => runFormCroScoringCheck(config, s), browser: true, timeout: 45000 },
    { name: 'Image Audit', fn: (s) => runImageAuditCheck(config, s), browser: true, timeout: 60000 },
    { name: 'Site-Wide Scan', fn: (s) => runSiteWideScanCheck(config, s), browser: true, timeout: 120000 },
    { name: 'Template & UI Health', fn: (s) => runTemplateUiHealthCheck(config, s), browser: true, timeout: 60000 },
    // Use the shared authenticated session so password-protected stores are
    // scanned on the real homepage, not the /password gate.
    { name: 'Shopify Analytics', fn: (s) => runShopifyAnalyticsCheck(config, s), browser: true, timeout: 20000 },
    { name: 'SEO', fn: (s) => runSeoCheck(config, s), browser: true, timeout: 45000 },
    { name: 'Broken Links', fn: (s) => runBrokenLinksCheck(config, s), browser: true, timeout: 45000 },

    { name: 'Page Health', fn: () => runPageHealthCheck(config) },
    { name: 'Shopify Admin Health', fn: () => runShopifyAdminHealthCheck(config) },
    { name: 'Shopify Theme', fn: () => runShopifyThemeCheck(config) },
    { name: 'Shopify Liquid Analysis', fn: () => runShopifyLiquidAnalysisCheck(config) },
    { name: 'Shopify Apps', fn: () => runShopifyAppsCheck(config) },
    { name: 'Shopify Products', fn: () => runShopifyProductsCheck(config) },
    { name: 'Shopify Products Deep', fn: () => runShopifyProductsDeepCheck(config) },
    { name: 'Shopify Content Quality', fn: () => runShopifyContentQualityCheck(config) },
    { name: 'Shopify Markets', fn: () => runShopifyMarketsCheck(config) },
    { name: 'Shopify Store Config', fn: () => runShopifyStoreConfigCheck(config) },
    { name: 'Shopify Code Review', fn: () => runShopifyCodeReviewCheck(config) },
    { name: 'Shopify Code Analysis', fn: () => runShopifyCodeAnalysisCheck(config) },
    { name: 'Multi-Language Detection', fn: () => runMultiLanguageDetectionCheck(config) },
  ]

  // Helper: wrap check with configurable timeout (default 30s)
  const withTimeout = async (fn: () => Promise<any>, ms = 30000): Promise<any> => {
    return Promise.race([
      fn(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`Check timeout after ${ms / 1000}s`)), ms)
      ),
    ])
  }

  // Run a single check, recording its result/error (thread-safe append).
  const runOne = async (check: CheckDef): Promise<void> => {
    const ms = check.timeout ?? 30000
    try {
      logger.info(`  Running: ${check.name}...`)
      const result = await withTimeout(() => check.fn(session), ms)
      results.push(result)
      const statusEmoji =
        result.status === 'pass' ? '✓' : result.status === 'fail' ? '✗' : result.status === 'warning' ? '⚠' : '○'
      logger.success(`  ${statusEmoji} ${check.name} — ${result.findings.length} finding(s), ${result.duration_ms}ms`)
    } catch (err: any) {
      const isTimeout = err.message.toLowerCase().includes('timeout')
      logger.error(`  ✗ ${check.name} failed${isTimeout ? ' (timeout)' : ''}: ${err.message}`)
      errors.push({ check: check.name, error: err.message })
      if (isTimeout) {
        results.push({
          id: check.name.toLowerCase().replace(/\s+/g, '-'),
          name: check.name,
          status: 'fail',
          duration_ms: ms,
          findings: [
            {
              id: `${check.name.toLowerCase().replace(/\s+/g, '-')}-timeout`,
              severity: 'high',
              title: `${check.name} timed out`,
              description: `Check did not complete within ${ms / 1000} seconds. This may indicate network issues or a hung process.`,
              recommendation: 'Re-run the audit or check network connectivity.',
            },
          ],
        })
      }
    }
  }

  // Browser checks run sequentially (they share one context → avoid page contention).
  const browserGroup = (async () => {
    for (const check of checks.filter((c) => c.browser)) {
      await runOne(check)
    }
  })()

  // API/network checks run concurrently in batches of 5 (network-bound, not CPU-bound).
  const apiGroup = (async () => {
    const apiChecks = checks.filter((c) => !c.browser)
    const BATCH = 5
    for (let i = 0; i < apiChecks.length; i += BATCH) {
      await Promise.all(apiChecks.slice(i, i + BATCH).map(runOne))
    }
  })()

  // Both groups run concurrently with each other.
  await Promise.all([browserGroup, apiGroup])

  await session.close()

  // Aggregate findings
  const allFindings = results.flatMap((r) => r.findings)
  const criticalFindings = allFindings.filter((f) => f.severity === 'critical').length
  const highFindings = allFindings.filter((f) => f.severity === 'high').length
  const mediumFindings = allFindings.filter((f) => f.severity === 'medium').length
  const lowFindings = allFindings.filter((f) => f.severity === 'low').length
  const infoFindings = allFindings.filter((f) => f.severity === 'info').length

  // Generate Layer 2 queue (findings that need investigation)
  const layer2Queue = allFindings
    .filter((f) => f.severity === 'critical' || f.severity === 'high')
    .map((f, idx) => ({
      id: `investigation-${idx + 1}`,
      type: f.severity === 'critical' ? ('error-context' as const) : ('anomaly' as const),
      title: f.title,
      description: f.description || '',
      priority: f.severity === 'critical' ? ('high' as const) : ('medium' as const),
    }))

  const duration = Date.now() - startTime

  logger.info('')
  logger.success(`✓ Layer 1 Complete in ${(duration / 1000).toFixed(1)}s`)
  logger.dim(`  Checks run: ${results.length}`)
  logger.dim(`  Critical: ${criticalFindings} | High: ${highFindings} | Medium: ${mediumFindings} | Low: ${lowFindings}`)
  logger.dim(`  Total findings: ${allFindings.length}`)
  if (errors.length > 0) {
    logger.warn(`  Failed checks: ${errors.length}`)
  }

  return {
    ran_at: timestamp(),
    store_domain: config.store_domain,
    all_checks: results,
    security: results.find((r) => r.id === 'security') as any,
    performance: results.find((r) => r.id === 'performance') as any,
    accessibility: results.find((r) => r.id === 'accessibility') as any,
    shopify_theme: results.find((r) => r.id === 'shopify-theme') as any,
    shopify_apps: results.find((r) => r.id === 'shopify-apps') as any,
    shopify_checkout: results.find((r) => r.id === 'shopify-checkout') as any,
    shopify_products: results.find((r) => r.id === 'shopify-products') as any,
    shopify_store_config: results.find((r) => r.id === 'shopify-store-config') as any,
    total_findings: allFindings.length,
    critical_findings: criticalFindings,
    high_findings: highFindings,
    medium_findings: mediumFindings,
    low_findings: lowFindings,
    layer2_queue: layer2Queue,
  }
}
