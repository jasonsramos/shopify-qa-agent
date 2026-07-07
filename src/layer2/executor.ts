import path from 'path'
import { SiteConfig, Layer1Results, Layer2FindingsFile } from '../types.js'
import { logger, writeFile } from '../utils.js'
import { analyzeGitHubTheme, generateThemeFindings } from './github-analyzer.js'
import { runDynamicInvestigations } from './investigations.js'
import { buildAgentContextFiles } from './agent-context-builder.js'
import { BrowserSession } from '../layer1/browser-session.js'
import * as fs from 'fs/promises'

/**
 * Layer 2: Dynamic automated investigations + GitHub theme analysis (zero-API).
 *
 * Runs targeted Playwright re-tests triggered by Layer 1 findings (checkout
 * flow, visual assessment, security/a11y verification, broken pages) and, when
 * a theme repo is provided, analyzes theme code. A rich layer2-prompt.md is also
 * emitted (see prompt-builder) for an optional Claude Code + Playwright MCP pass.
 */
export async function executeLayer2(
  config: SiteConfig,
  layer1Results: Layer1Results,
  layer2Prompt: string,
  outputDir: string
): Promise<Layer2FindingsFile> {
  const findings: Layer2FindingsFile = {
    tested_at: new Date().toISOString(),
    store_domain: config.store_domain,
    investigations: [],
  }

  logger.info('')
  logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  logger.info('🤖 LAYER 2: Dynamic Investigations + Theme Analysis')
  logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  logger.info('')

  // ── Dynamic automated investigations (driven by Layer 1 findings) ──
  const screenshotsDir = path.join(outputDir, 'screenshots')
  await fs.mkdir(screenshotsDir, { recursive: true })
  const session = new BrowserSession(config)
  try {
    await session.init()
    const dynamic = await runDynamicInvestigations(config, layer1Results, screenshotsDir, session)
    findings.investigations.push(...dynamic)
    logger.success(`✓ Ran ${dynamic.length} dynamic investigation(s)`)
  } catch (err: any) {
    logger.warn(`Dynamic investigations error: ${err.message}`)
  } finally {
    await session.close()
  }

  // ── Generate 5 lean agent-context files ──
  try {
    await buildAgentContextFiles(layer1Results, outputDir)
  } catch (err: any) {
    logger.warn(`Could not generate agent context files: ${err.message}`)
  }

  // ── GitHub theme analysis (only if a repo URL is provided) ──
  if (!config.project_path) {
    logger.info('📋 No theme repository provided — skipping theme code analysis')
    const findingsPath = path.join(outputDir, 'layer2-findings.json')
    await writeFile(findingsPath, JSON.stringify(findings, null, 2))
    return findings
  }

  try {
    // Analyze GitHub theme repository
    const themeAnalysis = await analyzeGitHubTheme(config.project_path)

    if (themeAnalysis.issues.length > 0) {
      logger.warn(`⚠️  Theme analysis issues: ${themeAnalysis.issues.join(', ')}`)
    }

    // Generate findings from theme analysis
    const themeFindings = generateThemeFindings(themeAnalysis)

    // Create investigation for theme code
    if (themeFindings.length > 0) {
      findings.investigations.push({
        id: 'theme-code-analysis',
        status: themeFindings.some((f) => f.severity === 'critical') ? 'fail' : 'warning',
        summary: `Theme analysis found ${themeFindings.length} issue(s)`,
        details: `Analyzed ${themeAnalysis.liquidFiles.length} Liquid, ${themeAnalysis.jsFiles.length} JavaScript, and ${themeAnalysis.cssFiles.length} CSS files.`,
        screenshots: [],
        issues: themeFindings.map((f) => ({
          severity: f.severity === 'critical' ? 'blocker' : f.severity === 'high' ? 'major' : 'minor',
          title: f.summary,
          description: f.description,
          location: 'Theme code',
          how_to_fix: `Review the ${f.id} finding and implement recommended changes`,
        })),
      })
    } else {
      findings.investigations.push({
        id: 'theme-code-analysis',
        status: 'pass',
        summary: 'Theme code follows best practices',
        details: `Successfully analyzed theme repository. No major issues detected.`,
        screenshots: [],
        issues: [],
      })
    }

    // Summary (security/checkout cross-checks are handled by dynamic investigations above)
    logger.success(`✓ Layer 2 analysis complete: ${findings.investigations.length} investigations`)
    logger.info(`  - Theme analysis: ${themeFindings.length} findings`)
  } catch (err: any) {
    logger.warn(`Layer 2 analysis error: ${err.message}`)

    findings.investigations.push({
      id: 'layer2-error',
      status: 'warning',
      summary: 'Layer 2 analysis encountered an error',
      details: `Theme analysis could not complete: ${err.message}`,
      screenshots: [],
      issues: [],
    })
  }

  // Save findings
  const findingsPath = path.join(outputDir, 'layer2-findings.json')
  await writeFile(findingsPath, JSON.stringify(findings, null, 2))
  logger.success(`✓ Layer 2 findings saved to layer2-findings.json`)

  return findings
}
