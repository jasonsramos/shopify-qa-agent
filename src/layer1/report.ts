import { Layer1Results, SiteConfig, Finding } from '../types.js'

/**
 * Generate a comprehensive markdown report from Layer 1 results
 */
export function generateReportMarkdown(results: Layer1Results, config: SiteConfig): string {
  const criticalFindings = results.all_checks.flatMap((c) => c.findings.filter((f) => f.severity === 'critical'))
  const highFindings = results.all_checks.flatMap((c) => c.findings.filter((f) => f.severity === 'high'))
  const mediumFindings = results.all_checks.flatMap((c) => c.findings.filter((f) => f.severity === 'medium'))

  let report = `# Shopify Store QA Report

**Store:** ${config.name}  
**Domain:** ${config.store_domain}  
**Plan:** ${config.store_plan}  
**Tested:** ${new Date(results.ran_at).toLocaleString()}

---

## Executive Summary

| Severity | Count |
|----------|-------|
| 🔴 Critical | ${results.critical_findings} |
| 🟠 High | ${results.high_findings} |
| 🟡 Medium | ${mediumFindings.length} |
| 🔵 Low | ${results.all_checks.flatMap((c) => c.findings.filter((f) => f.severity === 'low')).length} |

**Total Findings:** ${results.total_findings}

`

  // Recommendation
  if (results.critical_findings > 0) {
    report += `### ⛔ Recommendation: BLOCKED

**${results.critical_findings} critical issues must be fixed before launch.**

`
  } else if (results.high_findings > 0) {
    report += `### ⚠️  Recommendation: CONDITIONAL

**${results.high_findings} high-priority issues should be addressed.**

`
  } else {
    report += `### ✅ Recommendation: APPROVED

**No critical or high-priority issues detected.**

`
  }

  // Critical Issues
  if (criticalFindings.length > 0) {
    report += `---

## 🔴 Critical Issues (Must Fix)

${criticalFindings.map((f, i) => formatFinding(f, i + 1)).join('\n')}

`
  }

  // High Issues
  if (highFindings.length > 0) {
    report += `---

## 🟠 High Priority Issues

${highFindings.map((f, i) => formatFinding(f, i + 1)).join('\n')}

`
  }

  // Medium Issues
  if (mediumFindings.length > 0) {
    report += `---

## 🟡 Medium Priority Issues

${mediumFindings
  .slice(0, 10)
  .map((f, i) => formatFinding(f, i + 1))
  .join('\n')}

${mediumFindings.length > 10 ? `\n*+ ${mediumFindings.length - 10} more medium issues (see full report for details)*\n` : ''}

`
  }

  // Check Summary
  report += `---

## Check Results Summary

${results.all_checks
  .map((check) => {
    const statusEmoji =
      check.status === 'pass' ? '✅' : check.status === 'fail' ? '❌' : check.status === 'warning' ? '⚠️' : '⭕'
    const findingCount = check.findings.length
    return `| ${statusEmoji} ${check.name} | ${findingCount} finding(s) | ${check.duration_ms}ms |`
  })
  .join('\n')}

`

  // Next Steps
  report += `---

## Next Steps

1. **Address Critical Issues** — These must be fixed before launch
2. **Fix High Priority Issues** — These significantly impact user experience
3. **Consider Medium Issues** — Fix if time permits
4. **Layer 2 Investigation** — Automated checks are complete. Layer 2 will provide adaptive testing for complex scenarios.

---

## How to Use This Report

- **For Development:** Share with your team. Each finding includes specific recommendations.
- **For Launch Checklist:** Critical and High issues must be resolved.
- **For Monitoring:** Re-run this audit after each major change.

`

  return report
}

function formatFinding(finding: Finding, index: number): string {
  return `### ${index}. ${finding.title}

**Severity:** ${finding.severity}

${finding.description || ''}

**Fix:** ${finding.recommendation || 'See description for details'}

${finding.evidence ? `**Evidence:** \`${finding.evidence}\`` : ''}
`
}
