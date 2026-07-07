import { SiteConfig, CheckResult, Finding } from '../../types.js'
import { ShopifyAdminClient } from '../../shopify-api.js'
import { logger } from '../../utils.js'

export async function runShopifyLiquidAnalysisCheck(config: SiteConfig): Promise<CheckResult> {
  const startTime = Date.now()
  const findings: Finding[] = []

  if (!config.admin_access_token) {
    findings.push({
      id: 'liquid-analysis-requires-token',
      severity: 'info',
      title: 'Liquid code analysis requires Admin API token',
      description: 'Theme code analysis is skipped without admin credentials.',
    })

    return {
      id: 'shopify-liquid-analysis',
      name: 'Shopify Liquid Analysis',
      status: 'skipped',
      duration_ms: Date.now() - startTime,
      findings,
    }
  }

  try {
    const client = new ShopifyAdminClient(config)

    // Get active theme
    const theme = await client.getActiveTheme()
    const assets = await client.getThemeAssets(theme.id)

    logger.debug(`Theme "${theme.name}" has ${assets.length} assets`)

    // Count Liquid files
    const liquidFiles = assets.filter((a) => a.key.endsWith('.liquid'))
    const customSections = assets.filter((a) => a.key.startsWith('sections/') && !['announcement-bar', 'header', 'footer'].some((s) => a.key.includes(s)))

    // Check for custom layouts (sign of customization)
    const customLayouts = assets.filter((a) => a.key.startsWith('layout/') && a.key !== 'layout/theme.liquid')

    // Flag if too many custom files (sign of over-customization)
    if (liquidFiles.length > 100) {
      findings.push({
        id: 'liquid-too-many-files',
        severity: 'medium',
        title: `High number of Liquid files (${liquidFiles.length})`,
        description: `Theme has ${liquidFiles.length} Liquid template files. High customization increases maintenance burden and potential for bugs.`,
        recommendation: 'Consider refactoring or consolidating custom code into sections and includes.',
      })
    }

    // Warn if custom layouts detected
    if (customLayouts.length > 0) {
      findings.push({
        id: 'liquid-custom-layouts',
        severity: 'low',
        title: `${customLayouts.length} custom layout file(s) detected`,
        description: `Custom layout files detected. This indicates significant theme customization.`,
        recommendation: 'Ensure custom layouts are well-tested and documented.',
      })
    }

    // Warn about custom sections
    if (customSections.length > 10) {
      findings.push({
        id: 'liquid-many-custom-sections',
        severity: 'low',
        title: `${customSections.length} custom sections detected`,
        description: `Found ${customSections.length} custom section files. While sections are the recommended way to extend themes, ensure they are properly maintained.`,
      })
    }

    // Check theme age
    const themeAge = Date.now() - new Date(theme.updated_at).getTime()
    const monthsOld = Math.floor(themeAge / (1000 * 60 * 60 * 24 * 30))

    if (monthsOld > 18) {
      findings.push({
        id: 'liquid-theme-outdated',
        severity: 'medium',
        title: `Theme last updated ${monthsOld} months ago`,
        description: `Theme was last updated ${monthsOld} months ago. Consider updating to get bug fixes and new features.`,
        recommendation: 'Check Shopify theme marketplace for updates or newer themes.',
      })
    }

    if (findings.length === 0) {
      findings.push({
        id: 'liquid-analysis-clean',
        severity: 'info',
        title: 'Liquid code structure looks healthy',
        description: `Theme has ${liquidFiles.length} Liquid files with ${customSections.length} custom sections. Code structure appears well-maintained.`,
      })
    }

    return {
      id: 'shopify-liquid-analysis',
      name: 'Shopify Liquid Analysis',
      status: findings.some((f) => f.severity === 'high') ? 'fail' : findings.some((f) => f.severity === 'medium') ? 'warning' : 'pass',
      duration_ms: Date.now() - startTime,
      findings,
    }
  } catch (err: any) {
    logger.debug(`Liquid analysis error: ${err.message}`)
    findings.push({
      id: 'liquid-analysis-error',
      severity: 'high',
      title: 'Liquid code analysis failed',
      description: `Could not analyze theme: ${err.message}`,
      recommendation: 'Verify your Admin API token has theme read permissions.',
    })

    return {
      id: 'shopify-liquid-analysis',
      name: 'Shopify Liquid Analysis',
      status: 'fail',
      duration_ms: Date.now() - startTime,
      findings,
    }
  }
}
