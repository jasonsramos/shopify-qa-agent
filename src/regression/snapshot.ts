import * as fs from 'fs/promises'
import path from 'path'
import { Layer1Results, SiteConfig, Snapshot, FindingFingerprint } from '../types.js'
import { logger } from '../utils.js'

const BASELINE_DIR = path.join('qa-reports', '_baselines')

function baselinePath(storeDomain: string): string {
  const safe = storeDomain.replace(/[^a-z0-9.-]/gi, '_')
  return path.join(BASELINE_DIR, `${safe}.json`)
}

/** Build a stable fingerprint list from Layer 1 findings (info excluded). */
export function fingerprintLayer1(l1: Layer1Results): FindingFingerprint[] {
  const fps: FindingFingerprint[] = []
  for (const check of l1.all_checks) {
    for (const f of check.findings) {
      if (f.severity === 'info') continue
      fps.push({
        key: `${check.id}::${f.id}`,
        checkId: check.id,
        findingId: f.id,
        severity: f.severity,
        title: f.title,
      })
    }
  }
  return fps
}

/** Build a Snapshot object from a Layer 1 run. */
export function buildSnapshot(l1: Layer1Results, _config: SiteConfig): Snapshot {
  const theme = l1.shopify_theme as any
  const appsResult = l1.shopify_apps as any
  const apps: { handle: string; title: string }[] = Array.isArray(appsResult?.apps_installed)
    ? appsResult.apps_installed.map((a: any) => ({ handle: a.handle || a.title, title: a.title }))
    : []

  return {
    ran_at: l1.ran_at,
    store_domain: l1.store_domain,
    theme_id: theme?.theme?.id || theme?.id,
    theme_updated_at: theme?.theme?.updated_at || theme?.updated_at,
    apps,
    fingerprints: fingerprintLayer1(l1),
    counts: {
      critical: l1.critical_findings,
      high: l1.high_findings,
      medium: l1.medium_findings,
      low: l1.low_findings,
      info: 0,
    },
  }
}

/** Persist a snapshot as the new baseline for this store. */
export async function saveSnapshot(l1: Layer1Results, config: SiteConfig): Promise<string> {
  const snapshot = buildSnapshot(l1, config)
  const file = baselinePath(config.store_domain)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, JSON.stringify(snapshot, null, 2), 'utf-8')
  logger.success(`✓ Baseline snapshot saved → ${file}`)
  return file
}

/** Load the existing baseline, or null if none exists. */
export async function loadSnapshot(storeDomain: string): Promise<Snapshot | null> {
  try {
    const content = await fs.readFile(baselinePath(storeDomain), 'utf-8')
    return JSON.parse(content) as Snapshot
  } catch {
    return null
  }
}
