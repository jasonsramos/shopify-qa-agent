import * as fs from 'fs/promises'
import path from 'path'
import { Layer1Results, Layer2FindingsFile, RegressionResult } from '../types.js'
import { logger, readJson, writeFile } from '../utils.js'
import { markdownToPdf } from '../pdf-generator.js'

export async function mergeReports(reportDir: string): Promise<void> {
  try {
    logger.info(`Merging reports from ${reportDir}`)

    const layer1Results = (await readJson(path.join(reportDir, 'layer1-results.json'))) as Layer1Results

    let layer2Findings: Layer2FindingsFile | null = null
    try {
      layer2Findings = (await readJson(path.join(reportDir, 'layer2-findings.json'))) as Layer2FindingsFile
    } catch {
      logger.warn(`Layer 2 findings not found. Generating L1-only final report.`)
    }

    let regression: RegressionResult | null = null
    try {
      regression = (await readJson(path.join(reportDir, 'regression.json'))) as RegressionResult
    } catch { /* optional */ }

    const finalReportMd = generateFinalReport(layer1Results, layer2Findings, regression)
    const finalReportPath = path.join(reportDir, 'final-report.md')
    await writeFile(finalReportPath, finalReportMd)
    logger.success(`✓ Final report saved to ${finalReportPath}`)

    try {
      await markdownToPdf(finalReportPath)
    } catch (err: any) {
      logger.warn(`PDF generation failed (non-fatal): ${err.message}`)
    }

    logger.success(`✓ Reports merged successfully`)
  } catch (err: any) {
    logger.error(`Failed to merge reports: ${err.message}`)
    throw err
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function severityLabel(s: string): string {
  return s === 'critical' || s === 'blocker' ? '🚨 Blocker'
    : s === 'high' || s === 'major' ? '⚠️ Major'
    : '💡 Minor'
}

function renderIssueBlock(
  title: string,
  source: string,
  location: string,
  description: string,
  fix: string
): string {
  return `### ${title}
**Source:** ${source}
**Location:** ${location}
${description}
**Fix:** ${fix}

`
}

// Collect all issues across L1 + L2 grouped by severity
function collectAllIssues(layer1: Layer1Results, layer2: Layer2FindingsFile | null) {
  const blockers: { title: string; source: string; location: string; description: string; fix: string }[] = []
  const majors: typeof blockers = []
  const minors: typeof blockers = []

  // L1 findings
  for (const check of layer1.all_checks) {
    for (const f of check.findings) {
      if (f.severity === 'info') continue
      const item = {
        title: f.title,
        source: `L1:${check.id}`,
        location: `https://${layer1.store_domain}`,
        description: f.description || '',
        fix: f.recommendation || 'Review and address this finding.',
      }
      if (f.severity === 'critical') blockers.push(item)
      else if (f.severity === 'high') majors.push(item)
      else minors.push(item)
    }
  }

  // L2 findings
  if (layer2) {
    for (const inv of layer2.investigations) {
      for (const issue of inv.issues) {
        const item = {
          title: issue.title,
          source: `L2:${inv.id}`,
          location: issue.location || `https://${layer1.store_domain}`,
          description: issue.description || '',
          fix: issue.how_to_fix || 'Review and address this finding.',
        }
        if (issue.severity === 'blocker') blockers.push(item)
        else if (issue.severity === 'major') majors.push(item)
        else minors.push(item)
      }
    }
  }

  return { blockers, majors, minors }
}

function renderPerformanceTable(layer1: Layer1Results): string {
  const perfCheck = layer1.all_checks.find((c) => c.id === 'performance') as any
  const ls = perfCheck?.lighthouse_scores

  if (!ls || (!ls.mobile && !ls.desktop)) {
    return `## Performance

No Lighthouse scores available. Add \`PAGESPEED_API_KEY\` to \`.env\` for full Lighthouse scores.

`
  }

  const grade = (score: number) => score >= 90 ? '🟢' : score >= 50 ? '🟡' : '🔴'
  const cwv = (value: number, good: number, poor: number) =>
    value <= good ? '✅ Good' : value <= poor ? '⚠️ Needs Improvement' : '❌ Poor'

  const m = ls.mobile ?? {}
  const d = ls.desktop ?? {}

  // A category score of 0 means "not measured" (PSI skipped/unavailable), not a
  // real 0/100 — render n/a instead of a misleading red zero.
  const cell = (score: number | undefined) => (score ? `${score} ${grade(score)}` : 'n/a')

  // If nothing was actually measured, don't render a table of n/a rows.
  const anyScore = [m.performance, m.accessibility, m.best_practices, m.seo, d.performance, d.accessibility, d.best_practices, d.seo].some((s: number) => !!s)
  if (!anyScore) {
    return `## Performance

Lighthouse category scores unavailable for this run${ls ? ' (external PageSpeed API cannot audit password-protected stores — browser-based metrics were collected instead; see Performance Audit findings)' : ''}.

`
  }

  return `## Performance

| Metric | Mobile | Desktop |
|--------|--------|---------|
| Performance | ${cell(m.performance)} | ${cell(d.performance)} |
| Accessibility | ${cell(m.accessibility)} | ${cell(d.accessibility)} |
| Best Practices | ${cell(m.best_practices)} | ${cell(d.best_practices)} |
| SEO | ${cell(m.seo)} | ${cell(d.seo)} |

### Core Web Vitals (Mobile)

| Metric | Value | Status |
|--------|-------|--------|
| FCP | ${m.fcp_ms ?? 0}ms | ${cwv(m.fcp_ms ?? 0, 1800, 3000)} |
| LCP | ${m.lcp_ms ?? 0}ms | ${cwv(m.lcp_ms ?? 0, 2500, 4000)} |
| CLS | ${m.cls ?? 0} | ${cwv(m.cls ?? 0, 0.1, 0.25)} |
| TBT | ${m.tbt_ms ?? 0}ms | ${cwv(m.tbt_ms ?? 0, 200, 600)} |
| Speed Index | ${m.speed_index_ms ?? 0}ms | ${cwv(m.speed_index_ms ?? 0, 3400, 5800)} |

`
}

function renderShopifyHealth(layer1: Layer1Results): string {
  const lines: string[] = []

  // Extract key info from checks
  const themeCheck = layer1.all_checks.find((c) => c.id === 'shopify-theme')
  const appsCheck = layer1.all_checks.find((c) => c.id === 'shopify-apps')
  const productsCheck = layer1.all_checks.find((c) => c.id === 'shopify-products')

  // Theme info
  if (themeCheck?.findings.length) {
    const themeInfo = themeCheck.findings[0]?.description || ''
    if (themeInfo) lines.push(`- **Theme:** ${themeInfo.split('\n')[0]}`)
  }

  // Apps installed
  if (appsCheck) {
    const appCount = appsCheck.findings.length
    lines.push(`- **Apps:** ${appCount} app${appCount !== 1 ? 's' : ''} installed`)
  }

  // Products count
  if (productsCheck?.findings.length) {
    const productInfo = productsCheck.findings[0]?.description || ''
    if (productInfo.includes('product')) {
      lines.push(`- **Products:** ${productInfo.split('\n')[0]}`)
    }
  }

  if (lines.length === 0) return ''

  return `## Shopify Health

${lines.join('\n')}

`
}

function renderPassedChecks(layer1: Layer1Results): string {
  const passed = layer1.all_checks.filter((c) => c.status === 'pass')
  if (passed.length === 0) return ''
  return `## ✅ Passed Checks

${passed.map((c) => `- **${c.name}**`).join('\n')}

`
}

function renderRegression(regression: RegressionResult | null): string {
  if (!regression || !regression.hasBaseline) return ''
  const { newIssues, resolvedIssues, regressed, themeChanged, themeDetail, appChanges } = regression
  const baseline = regression.baselineRanAt ? new Date(regression.baselineRanAt).toLocaleString() : 'unknown'

  if (!newIssues.length && !resolvedIssues.length && !regressed.length && !themeChanged && !appChanges.added.length && !appChanges.removed.length) {
    return `## Changes Since Last Run\n\n_No changes since baseline (${baseline})._\n\n---\n\n`
  }

  const list = (items: { severity: string; title: string }[]) =>
    items.slice(0, 15).map((i) => `- [${i.severity}] ${i.title}`).join('\n') || '_none_'

  return `## Changes Since Last Run

Compared against baseline from **${baseline}**.

| Change | Count |
|--------|-------|
| 🆕 New issues | ${newIssues.length} |
| ✅ Resolved | ${resolvedIssues.length} |
| ⬆️ Regressed | ${regressed.length} |

${themeChanged ? `**🎨 Theme:** ${themeDetail}\n\n` : ''}${appChanges.added.length ? `**➕ Apps added:** ${appChanges.added.join(', ')}\n\n` : ''}${appChanges.removed.length ? `**➖ Apps removed:** ${appChanges.removed.join(', ')}\n\n` : ''}${newIssues.length > 0 ? `### 🆕 New\n\n${list(newIssues)}\n\n` : ''}${regressed.length > 0 ? `### ⬆️ Regressed\n\n${list(regressed)}\n\n` : ''}${resolvedIssues.length > 0 ? `### ✅ Resolved\n\n${list(resolvedIssues)}\n\n` : ''}---

`
}

// ─── Main report generator ───────────────────────────────────────────────────

function generateFinalReport(
  layer1: Layer1Results,
  layer2: Layer2FindingsFile | null,
  regression: RegressionResult | null = null
): string {
  const { blockers, majors, minors } = collectAllIssues(layer1, layer2)
  const overallStatus = blockers.length > 0 ? 'CRITICAL' : majors.length > 0 ? 'WARNING' : 'APPROVED'
  const statusLine = blockers.length > 0
    ? `**${blockers.length} blockers, ${majors.length} major issues, ${minors.length} minor issues**`
    : majors.length > 0
    ? `**${majors.length} major issues, ${minors.length} minor issues**`
    : `**No critical issues. Store is ready for launch.**`

  // ── Header ──
  let report = `# QA Report — ${`https://${layer1.store_domain}`}
Generated: ${layer1.ran_at}
Layer 1 Duration: ${(layer1.all_checks.reduce((a, c) => a + (c.duration_ms || 0), 0) / 1000).toFixed(1)}s
Layers: L1${layer2 ? ' + L2 (full)' : ' only'}

## 🚨 Overall Status: ${overallStatus}

${statusLine}

`

  // ── Regression ──
  report += renderRegression(regression)

  // ── Blockers ──
  if (blockers.length > 0) {
    report += `## 🚨 Blocker Issues\n\n`
    for (const b of blockers) {
      report += renderIssueBlock(b.title, b.source, b.location, b.description, b.fix)
    }
  }

  // ── Majors ──
  if (majors.length > 0) {
    report += `## ⚠️ Major Issues\n\n`
    for (const m of majors) {
      report += renderIssueBlock(m.title, m.source, m.location, m.description, m.fix)
    }
  }

  // ── Minors ──
  if (minors.length > 0) {
    report += `## 💡 Minor Issues\n\n`
    for (const m of minors) {
      report += `- **${m.title}** (${m.source} — ${m.location}): ${m.description} Fix: ${m.fix}\n`
    }
    report += '\n'
  }

  // ── Layer 1 summary table ──
  report += `## Layer 1 — Automated Checks\n\n`
  report += `| Check | Status | Detail |\n|-------|--------|--------|\n`
  for (const c of layer1.all_checks) {
    const icon = c.status === 'pass' ? '✅ PASS' : c.status === 'fail' ? '❌ FAIL' : '⚠️ WARN'
    const detail = c.findings.length > 0
      ? `${c.findings.length} finding${c.findings.length > 1 ? 's' : ''}`
      : '—'
    report += `| ${c.name} | ${icon} | ${detail} |\n`
  }
  report += '\n'

  // ── Layer 2 summary ──
  if (layer2 && layer2.investigations.length > 0) {
    report += `## Layer 2 — Adaptive Testing\n\n`
    for (const inv of layer2.investigations) {
      const icon = inv.status === 'pass' ? '✅' : inv.status === 'fail' ? '❌' : '⚠️'
      report += `### ${icon} ${inv.id}\n`
      report += `**Summary:** ${inv.summary}\n\n`
      if (inv.details) report += `${inv.details}\n\n`
      if (inv.screenshots.length > 0) {
        report += `**Screenshots:** ${inv.screenshots.map((s) => `[${s}](screenshots/${s})`).join(', ')}\n\n`
      }
    }
  }

  // ── Performance ──
  report += renderPerformanceTable(layer1)

  // ── Shopify Health ──
  report += renderShopifyHealth(layer1)

  // ── Passed checks ──
  report += renderPassedChecks(layer1)

  return report
}
