import { SiteConfig, CheckResult, Finding } from '../../types.js'
import { ShopifyAdminClient } from '../../shopify-api.js'
import { logger } from '../../utils.js'

export async function runShopifyThemeCheck(config: SiteConfig): Promise<CheckResult> {
  const startTime = Date.now()
  const findings: Finding[] = []

  // Without credentials, skip
  if (!config.admin_access_token) {
    return {
      id: 'shopify-theme',
      name: 'Shopify Theme Check',
      status: 'pass',
      duration_ms: Date.now() - startTime,
      findings: [
        {
          id: 'theme-check-skipped',
          severity: 'info',
          title: 'Theme check skipped (no credentials)',
          description: 'Admin API token required to fetch theme details.',
          recommendation: 'Pass --access-token to enable full theme analysis.',
        },
      ],
      theme_name: 'Unknown',
      theme_id: '',
      has_custom_code: false,
      custom_sections: [],
      custom_liquid_includes: [],
      issues: [],
    } as any
  }

  try {
    const client = new ShopifyAdminClient(config)

    // Fetch active theme
    const theme = await client.getActiveTheme()

    if (!theme) {
      findings.push({
        id: 'theme-not-found',
        severity: 'high',
        title: 'Active theme not found',
        description: 'Could not retrieve active theme from Admin API.',
        recommendation: 'Verify store has a published theme.',
      })

      return {
        id: 'shopify-theme',
        name: 'Shopify Theme Check',
        status: 'warning',
        duration_ms: Date.now() - startTime,
        findings,
        theme_name: 'Unknown',
        theme_id: '',
        has_custom_code: false,
        custom_sections: [],
        custom_liquid_includes: [],
        issues: findings,
      } as any
    }

    // Fetch theme assets to count custom files
    const assets = await client.getThemeAssets(theme.id)
    const liquidFiles = assets.filter((a) => a.key.endsWith('.liquid'))
    const customSections = liquidFiles.filter((a) => a.key.includes('sections/'))
    const customLiquidIncludes = liquidFiles.filter((a) => a.key.includes('snippets/'))

    // Check theme age
    const themeUpdated = new Date(theme.updated_at || '')
    const ageMs = Date.now() - themeUpdated.getTime()
    const ageMonths = ageMs / (1000 * 60 * 60 * 24 * 30)

    if (ageMonths > 18) {
      findings.push({
        id: 'theme-outdated',
        severity: 'medium',
        title: `Theme last updated ${Math.round(ageMonths)} months ago`,
        description: `Theme "${theme.name}" was last updated ${themeUpdated.toLocaleDateString()}. Older themes may have security issues or performance problems.`,
        recommendation: 'Consider updating to a newer theme version or rebuilding with modern Shopify features.',
        evidence: `${Math.round(ageMonths)} months old`,
      })
    }

    // Check for custom code
    if (customSections.length > 5) {
      findings.push({
        id: 'many-custom-sections',
        severity: 'info',
        title: `${customSections.length} custom sections detected`,
        description: `Theme has ${customSections.length} custom sections. This indicates significant customization. Ensure custom code is maintainable and performant.`,
        recommendation: 'Review custom section code for performance and accessibility.',
        evidence: `${customSections.length} sections`,
      })
    }

    // Check for theme configuration
    const hasSettings = assets.some((a) => a.key === 'config/settings_data.json')
    if (!hasSettings) {
      findings.push({
        id: 'missing-settings-data',
        severity: 'low',
        title: 'Theme settings not configured',
        description: 'config/settings_data.json not found. Theme may not be fully configured.',
        recommendation: 'Configure theme via Shopify admin or ensure settings_data.json exists.',
      })
    }

    // Summary
    if (findings.length === 0) {
      findings.push({
        id: 'theme-healthy',
        severity: 'info',
        title: `Theme healthy: ${theme.name}`,
        description: `Theme is up-to-date (${liquidFiles.length} Liquid files, ${customSections.length} sections). Well-maintained.`,
      })
    }

    return {
      id: 'shopify-theme',
      name: 'Shopify Theme Check',
      status: findings.some((f) => f.severity === 'high' || f.severity === 'critical') ? 'warning' : 'pass',
      duration_ms: Date.now() - startTime,
      findings,
      theme_name: theme.name,
      theme_id: theme.id,
      has_custom_code: customSections.length > 0,
      custom_sections: customSections.map((a) => a.key),
      custom_liquid_includes: customLiquidIncludes.map((a) => a.key),
      issues: findings,
    } as any
  } catch (err: any) {
    logger.debug(`Theme check error: ${err.message}`)

    findings.push({
      id: 'theme-check-failed',
      severity: 'medium',
      title: 'Theme check failed',
      description: `Could not fetch theme details: ${err.message}`,
      recommendation: 'Verify admin credentials and store access.',
    })

    return {
      id: 'shopify-theme',
      name: 'Shopify Theme Check',
      status: 'warning',
      duration_ms: Date.now() - startTime,
      findings,
      theme_name: 'Unknown',
      theme_id: '',
      has_custom_code: false,
      custom_sections: [],
      custom_liquid_includes: [],
      issues: findings,
    } as any
  }
}
