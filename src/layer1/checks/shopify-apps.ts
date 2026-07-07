import { SiteConfig, CheckResult, Finding } from '../../types.js'
import { ShopifyAdminClient, detectAppConflicts, checkMissingCriticalApps } from '../../shopify-api.js'
import { logger } from '../../utils.js'

export async function runShopifyAppsCheck(config: SiteConfig): Promise<CheckResult> {
  const startTime = Date.now()
  const findings: Finding[] = []

  if (!config.admin_access_token) {
    findings.push({
      id: 'no-admin-token',
      severity: 'info',
      title: 'Admin API token not configured',
      description: 'App checking requires admin_access_token in config.',
      recommendation: 'Add admin_access_token to enable app detection.',
    })

    return {
      id: 'shopify-apps',
      name: 'Shopify Apps Check',
      status: 'pass',
      duration_ms: Date.now() - startTime,
      findings,
      apps_installed: [],
      known_conflicts: [],
      performance_impact: [],
      critical_apps_missing: [],
    } as any
  }

  try {
    const client = new ShopifyAdminClient(config)
    logger.debug('Fetching installed apps from Shopify Admin API')

    // Get installed apps
    const apps = await client.getInstalledApps()

    // Check for known conflicts
    const conflicts = detectAppConflicts(apps)
    if (conflicts.length > 0) {
      for (const conflict of conflicts) {
        findings.push({
          id: `app-conflict-${conflict.app1}-${conflict.app2}`,
          severity: conflict.severity as any,
          title: `App Conflict: ${conflict.app1} + ${conflict.app2}`,
          description: conflict.issue,
          recommendation: 'Review compatibility or consider alternatives.',
        })
      }
    }

    // Check for missing critical apps
    const missingCritical = checkMissingCriticalApps(apps, config.critical_apps)
    if (missingCritical.length > 0) {
      findings.push({
        id: 'missing-critical-apps',
        severity: 'low',
        title: `Missing critical apps: ${missingCritical.join(', ')}`,
        description: `${missingCritical.length} apps from your critical list are not installed.`,
        recommendation: 'Consider installing these apps for better store functionality.',
      })
    }

    // Detect performance-heavy apps
    const performanceApps = apps.filter((a) => {
      const heavyApps = ['Recharge', 'Bold Subscriptions', 'Klaviyo', 'Gorgias']
      return heavyApps.some((heavy) => a.title.toLowerCase().includes(heavy.toLowerCase()))
    })

    if (performanceApps.length > 3) {
      findings.push({
        id: 'many-heavy-apps',
        severity: 'medium',
        title: `${performanceApps.length} performance-heavy apps installed`,
        description: 'Multiple heavy apps can slow down your store.',
        recommendation: 'Monitor store performance. Consider consolidating apps.',
      })
    }

    return {
      id: 'shopify-apps',
      name: 'Shopify Apps Check',
      status: conflicts.some((c) => c.severity === 'critical') ? 'fail' : findings.length > 0 ? 'warning' : 'pass',
      duration_ms: Date.now() - startTime,
      findings,
      apps_installed: apps,
      known_conflicts: conflicts,
      performance_impact: performanceApps.map((a) => ({
        app_title: a.title,
        overhead_ms: 100, // Placeholder
        overhead_kb: 50,
        severity: 'medium' as const,
      })),
      critical_apps_missing: missingCritical,
    } as any
  } catch (err: any) {
    logger.debug(`Shopify apps check failed: ${err.message}`)

    findings.push({
      id: 'apps-check-failed',
      severity: 'info',
      title: 'Could not fetch apps via Admin API',
      description: `Error: ${err.message}`,
      recommendation: 'Verify admin_access_token is valid and has necessary scopes.',
    })

    return {
      id: 'shopify-apps',
      name: 'Shopify Apps Check',
      status: 'pass',
      duration_ms: Date.now() - startTime,
      findings,
      apps_installed: [],
      known_conflicts: [],
      performance_impact: [],
      critical_apps_missing: [],
    } as any
  }
}
