import { Layer1Results, SiteConfig, Snapshot, RegressionResult, FindingFingerprint } from '../types.js'
import { severityLevel } from '../utils.js'
import { buildSnapshot, loadSnapshot } from './snapshot.js'

/** Compare a current Layer 1 run against a stored baseline snapshot. */
export function diffSnapshots(current: Snapshot, baseline: Snapshot): RegressionResult {
  const curByKey = new Map(current.fingerprints.map((f) => [f.key, f]))
  const baseByKey = new Map(baseline.fingerprints.map((f) => [f.key, f]))

  const newIssues: FindingFingerprint[] = []
  const resolvedIssues: FindingFingerprint[] = []
  const regressed: FindingFingerprint[] = []

  for (const [key, cur] of curByKey) {
    const base = baseByKey.get(key)
    if (!base) {
      newIssues.push(cur)
    } else if (severityLevel(cur.severity) > severityLevel(base.severity)) {
      regressed.push(cur)
    }
  }
  for (const [key, base] of baseByKey) {
    if (!curByKey.has(key)) resolvedIssues.push(base)
  }

  const themeChanged =
    !!current.theme_id &&
    !!baseline.theme_id &&
    (current.theme_id !== baseline.theme_id || current.theme_updated_at !== baseline.theme_updated_at)
  const themeDetail = themeChanged
    ? current.theme_id !== baseline.theme_id
      ? `Theme changed (id ${baseline.theme_id} → ${current.theme_id})`
      : `Theme updated (${baseline.theme_updated_at} → ${current.theme_updated_at})`
    : undefined

  const baseHandles = new Set(baseline.apps.map((a) => a.handle))
  const curHandles = new Set(current.apps.map((a) => a.handle))
  const added = current.apps.filter((a) => !baseHandles.has(a.handle)).map((a) => a.title)
  const removed = baseline.apps.filter((a) => !curHandles.has(a.handle)).map((a) => a.title)

  return {
    hasBaseline: true,
    baselineRanAt: baseline.ran_at,
    newIssues,
    resolvedIssues,
    regressed,
    themeChanged,
    themeDetail,
    appChanges: { added, removed },
  }
}

/** Diff a current Layer 1 run against the stored baseline for the store. */
export async function diffAgainstBaseline(l1: Layer1Results, config: SiteConfig): Promise<RegressionResult> {
  const baseline = await loadSnapshot(config.store_domain)
  if (!baseline) {
    return {
      hasBaseline: false,
      newIssues: [],
      resolvedIssues: [],
      regressed: [],
      themeChanged: false,
      appChanges: { added: [], removed: [] },
    }
  }
  return diffSnapshots(buildSnapshot(l1, config), baseline)
}
