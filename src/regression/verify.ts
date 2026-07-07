import * as fs from 'fs/promises'
import path from 'path'
import { Layer1Results, FindingFingerprint } from '../types.js'
import { severityLevel } from '../utils.js'
import { fingerprintLayer1 } from './snapshot.js'

export interface VerificationResult {
  baselineRanAt: string
  currentRanAt: string
  storeDomain: string
  resolved: FindingFingerprint[]
  stillPresent: FindingFingerprint[]
  worse: { old: FindingFingerprint; current: FindingFingerprint }[]
  improved: { old: FindingFingerprint; current: FindingFingerprint }[]
  newIssues: FindingFingerprint[]
}

/** Load layer1-results.json from a report directory. */
export async function loadLayer1FromReport(reportDir: string): Promise<Layer1Results> {
  const file = path.join(reportDir, 'layer1-results.json')
  const content = await fs.readFile(file, 'utf-8')
  return JSON.parse(content) as Layer1Results
}

/**
 * Compare a current Layer 1 run against an OLDER report and categorize every
 * old finding as resolved / still present / worse / improved, plus anything new.
 * This is remediation tracking — "did the fixes land?" — as opposed to the
 * baseline diff which only surfaces changes.
 */
export function verifyAgainstReport(current: Layer1Results, baseline: Layer1Results): VerificationResult {
  const curFps = fingerprintLayer1(current)
  const baseFps = fingerprintLayer1(baseline)
  const curByKey = new Map(curFps.map((f) => [f.key, f]))
  const baseByKey = new Map(baseFps.map((f) => [f.key, f]))

  const resolved: FindingFingerprint[] = []
  const stillPresent: FindingFingerprint[] = []
  const worse: VerificationResult['worse'] = []
  const improved: VerificationResult['improved'] = []
  const newIssues: FindingFingerprint[] = []

  for (const [key, base] of baseByKey) {
    const cur = curByKey.get(key)
    if (!cur) {
      resolved.push(base)
    } else if (severityLevel(cur.severity) > severityLevel(base.severity)) {
      worse.push({ old: base, current: cur })
    } else if (severityLevel(cur.severity) < severityLevel(base.severity)) {
      improved.push({ old: base, current: cur })
    } else {
      stillPresent.push(cur)
    }
  }
  for (const [key, cur] of curByKey) {
    if (!baseByKey.has(key)) newIssues.push(cur)
  }

  return {
    baselineRanAt: baseline.ran_at,
    currentRanAt: current.ran_at,
    storeDomain: current.store_domain,
    resolved,
    stillPresent,
    worse,
    improved,
    newIssues,
  }
}

/** Render the verification result as a markdown report. */
export function renderVerificationMarkdown(v: VerificationResult, baselineDir: string): string {
  const row = (f: FindingFingerprint) => `| ${f.severity} | ${f.title} | \`${f.checkId}\` |`
  const table = (fps: FindingFingerprint[]) =>
    fps.length === 0
      ? '_None._\n'
      : `| Severity | Finding | Check |\n|---|---|---|\n${fps
          .sort((a, b) => severityLevel(b.severity) - severityLevel(a.severity))
          .map(row)
          .join('\n')}\n`

  const total = v.resolved.length + v.stillPresent.length + v.worse.length + v.improved.length
  const pct = total > 0 ? Math.round((v.resolved.length / total) * 100) : 0

  return `# Verification Report — ${v.storeDomain}

Comparing against baseline report: \`${baselineDir}\` (ran ${v.baselineRanAt})
Current run: ${v.currentRanAt}

## Summary

| Outcome | Count |
|---|---|
| ✅ Resolved | **${v.resolved.length}** |
| ❌ Still present | ${v.stillPresent.length} |
| ⬆️ Worse | ${v.worse.length} |
| ⬇️ Improved (severity reduced) | ${v.improved.length} |
| 🆕 New since baseline | ${v.newIssues.length} |

**Remediation rate: ${pct}%** (${v.resolved.length}/${total} baseline findings resolved)

> Note: automated checks can produce false negatives/positives. "Resolved" means the
> automated check no longer reproduces the finding; spot-check blockers manually.

## ✅ Resolved
${table(v.resolved)}
## ❌ Still Present
${table(v.stillPresent)}
## ⬆️ Worse
${
  v.worse.length === 0
    ? '_None._\n'
    : `| Was | Now | Finding | Check |\n|---|---|---|---|\n${v.worse
        .map((w) => `| ${w.old.severity} | **${w.current.severity}** | ${w.current.title} | \`${w.current.checkId}\` |`)
        .join('\n')}\n`
}
## 🆕 New Since Baseline
${table(v.newIssues)}
`
}
