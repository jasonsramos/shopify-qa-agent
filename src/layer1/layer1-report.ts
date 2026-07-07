import { Layer1Results, SiteConfig } from '../types.js'
import { timestamp, sortBySeverity } from '../utils.js'

/**
 * Generate verbose Layer 1 technical report (all severities, all details)
 */
export function generateLayer1Report(results: Layer1Results, config: SiteConfig): string {
  const storeName = config.name || config.store_domain
  const findinBySeverity = {
    critical: results.all_checks.flatMap((c) => c.findings).filter((f) => f.severity === 'critical'),
    high: results.all_checks.flatMap((c) => c.findings).filter((f) => f.severity === 'high'),
    medium: results.all_checks.flatMap((c) => c.findings).filter((f) => f.severity === 'medium'),
    low: results.all_checks.flatMap((c) => c.findings).filter((f) => f.severity === 'low'),
    info: results.all_checks.flatMap((c) => c.findings).filter((f) => f.severity === 'info'),
  }

  return `# Shopify Store QA — Layer 1 Technical Report

**Store:** ${storeName}
**Domain:** ${config.store_domain}
**Plan:** ${config.store_plan || 'Unknown'}
**Tested:** ${new Date(results.ran_at).toLocaleString()}

---

## Executive Summary

| Severity | Count |
|----------|-------|
| 🔴 Critical | ${results.critical_findings} |
| 🟠 High | ${results.high_findings} |
| 🟡 Medium | ${results.medium_findings} |
| 🔵 Low | ${results.low_findings} |
| ℹ️ Info | ${results.all_checks.flatMap((c) => c.findings).filter((f) => f.severity === 'info').length} |

**Total Findings:** ${results.total_findings}
**Checks Run:** ${results.all_checks.length}

---

## Findings by Severity

### 🔴 Critical (${findinBySeverity.critical.length})

${findinBySeverity.critical.length === 0 ? '_No critical findings._' : findinBySeverity.critical.map((f) => generateFindingBlock(f)).join('\n\n')}

### 🟠 High (${findinBySeverity.high.length})

${findinBySeverity.high.length === 0 ? '_No high findings._' : findinBySeverity.high.map((f) => generateFindingBlock(f)).join('\n\n')}

### 🟡 Medium (${findinBySeverity.medium.length})

${findinBySeverity.medium.length === 0 ? '_No medium findings._' : findinBySeverity.medium.map((f) => generateFindingBlock(f)).join('\n\n')}

### 🔵 Low (${findinBySeverity.low.length})

${findinBySeverity.low.length === 0 ? '_No low findings._' : findinBySeverity.low.map((f) => generateFindingBlock(f)).join('\n\n')}

### ℹ️ Info (${findinBySeverity.info.length})

${findinBySeverity.info.length === 0 ? '_No info messages._' : findinBySeverity.info.map((f) => generateFindingBlock(f)).join('\n\n')}

---

## Per-Check Results

${results.all_checks
  .map((check) => {
    const statusEmoji = check.status === 'pass' ? '✅' : check.status === 'fail' ? '❌' : check.status === 'warning' ? '⚠️' : '⊘'
    return `### ${statusEmoji} ${check.name}

**Status:** ${check.status.toUpperCase()} | **Duration:** ${check.duration_ms}ms | **Findings:** ${check.findings.length}

${check.findings.length === 0 ? '_No findings._' : check.findings.map((f) => `- **${f.severity.toUpperCase()}**: ${f.title}`).join('\n')}

${check.findings.length > 0 ? '\n' + check.findings.map((f) => generateFindingBlock(f)).join('\n\n') : ''}`
  })
  .join('\n\n---\n\n')}

---

## Layer 2 Investigation Queue

${results.layer2_queue.length === 0 ? '_No issues queued for Layer 2 investigation._' : ''}

${results.layer2_queue
  .filter((i) => i.priority === 'high')
  .map((i) => `**[HIGH]** ${i.title}`)
  .join('\n')}

${results.layer2_queue
  .filter((i) => i.priority === 'medium')
  .map((i) => `**[MEDIUM]** ${i.title}`)
  .join('\n')}

${results.layer2_queue
  .filter((i) => i.priority === 'low')
  .map((i) => `**[LOW]** ${i.title}`)
  .join('\n')}

---

## Metadata

- **Report Generated:** ${timestamp()}
- **Total Findings:** ${results.total_findings}
- **Checks Executed:** ${results.all_checks.length}
- **Layer 2 Investigations Queued:** ${results.layer2_queue.length}
`
}

function generateFindingBlock(finding: any): string {
  return `#### ${finding.title}

**ID:** \`${finding.id}\`
**Severity:** ${finding.severity}

${finding.description}

${finding.recommendation ? `\n**Fix:** ${finding.recommendation}\n` : ''}
${finding.evidence ? `\n**Evidence:** ${Array.isArray(finding.evidence) ? finding.evidence.join(', ') : finding.evidence}\n` : ''}`
}
