// ════════════════════════════════════════════════════════════════════════
// TYPES — Shopify QA Agent
// ════════════════════════════════════════════════════════════════════════

// ── Configuration ────────────────────────────────────────────────────────

export interface SiteConfig {
  name: string
  store_domain: string // e.g., "mystore.myshopify.com"
  store_url: string // e.g., "https://mystore.myshopify.com"
  admin_api_key: string
  admin_api_password?: string
  admin_access_token?: string
  store_type: 'standard' | 'plus' | 'b2b' | 'shopify-pay-only'
  store_plan: 'basic' | 'professional' | 'advanced' | 'plus' | 'enterprise'
  theme_name?: string
  theme_id?: string
  project_path?: string // local path to theme repo for code review
  storefront_password?: string // password for dev store password-protection bypass
  test_checkout: boolean
  test_on_mobile: boolean
  critical_apps: string[]
  skip_apps_check: string[]
  known_issues: string[]
  key_pages: string[]
  max_links_to_crawl: number
  timeout_ms: number
  enable_ai?: boolean // opt-in autonomous Layer 2 AI pass (requires ANTHROPIC_API_KEY)
}

// ── Layer 1: Automated Checks ────────────────────────────────────────────

export interface CheckResult {
  id: string
  name: string
  status: 'pass' | 'fail' | 'warning' | 'skipped'
  duration_ms: number
  findings: Finding[]
}

export interface Finding {
  id: string
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info'
  title: string
  description: string
  recommendation?: string
  evidence?: string | string[]
}

// ── Shopify Admin API Results ────────────────────────────────────────────

export interface ShopInfo {
  id: string
  name: string
  domain: string
  plan: string
  currency: string
  timezone: string
  country_code: string
  created_at: string
}

export interface Theme {
  id: string
  name: string
  role: 'main' | 'unpublished' | 'demo'
  created_at: string
  updated_at: string
}

export interface ShopifyApp {
  id: string
  title: string
  handle: string
  category: string
  status: 'installed' | 'uninstalled'
  installed_date?: string
  scopes?: string[]
}

export interface Product {
  id: string
  title: string
  handle: string
  vendor: string
  product_type: string
  status: 'active' | 'archived' | 'draft'
  created_at: string
}

export interface Collection {
  id: string
  title: string
  handle: string
  sort_order: string
  product_count: number
}

// ── Security Check Results ───────────────────────────────────────────────

export interface SecurityResult extends CheckResult {
  id: 'security'
  headers: SecurityHeaders
  exposed_files: ExposedFile[]
  vulnerabilities: SecurityFinding[]
}

export interface SecurityHeaders {
  [key: string]: string | undefined
  'content-security-policy'?: string
  'x-frame-options'?: string
  'x-content-type-options'?: string
  'strict-transport-security'?: string
  'referrer-policy'?: string
}

export interface ExposedFile {
  path: string
  status: number
  risk: string
}

export interface SecurityFinding extends Finding {
  category: string
}

// ── Performance Results ──────────────────────────────────────────────────

export interface PerformanceResult extends CheckResult {
  id: 'performance'
  lighthouse_scores: {
    desktop: LighthouseMetrics
    mobile: LighthouseMetrics
  }
  pages_tested: number
  avg_load_time_ms: number
  third_party_scripts: ThirdPartyScript[]
}

export interface LighthouseMetrics {
  performance: number
  accessibility: number
  best_practices: number
  seo: number
  fcp_ms: number
  lcp_ms: number
  fid_ms: number
  cls: number
  tbt_ms?: number
  speed_index_ms?: number
  tti_ms?: number
}

export interface ThirdPartyScript {
  src: string
  domain: string
  size_kb: number
  impact_ms: number
}

// ── Accessibility Results ────────────────────────────────────────────────

export interface AccessibilityResult extends CheckResult {
  id: 'accessibility'
  pages_tested: number
  wcag_violations: AccessibilityViolation[]
  contrast_issues: number
  missing_alt_text: number
  keyboard_navigation_broken: boolean
}

export interface AccessibilityViolation extends Finding {
  wcag_level: 'A' | 'AA' | 'AAA'
  element: string
}

// ── Shopify-Specific Checks ──────────────────────────────────────────────

export interface ShopifyThemeCheckResult extends CheckResult {
  id: 'shopify-theme'
  theme_name: string
  theme_id: string
  has_custom_code: boolean
  custom_sections: string[]
  custom_liquid_includes: string[]
  issues: Finding[]
}

export interface ShopifyAppsCheckResult extends CheckResult {
  id: 'shopify-apps'
  apps_installed: ShopifyApp[]
  known_conflicts: AppConflict[]
  performance_impact: AppPerformanceImpact[]
  critical_apps_missing: string[]
}

export interface AppConflict {
  app1: string
  app2: string
  issue: string
  severity: 'critical' | 'high' | 'medium'
  workaround?: string
}

export interface AppPerformanceImpact {
  app_title: string
  overhead_ms: number
  overhead_kb: number
  severity: 'critical' | 'high' | 'medium'
}

export interface ShopifyCheckoutCheckResult extends CheckResult {
  id: 'shopify-checkout'
  checkout_url: string
  checkout_loads: boolean
  form_fields_present: boolean
  payment_methods_configured: string[]
  shipping_configured: boolean
  test_payment_card_works: boolean
  issues: Finding[]
}

export interface ShopifyProductsCheckResult extends CheckResult {
  id: 'shopify-products'
  products_total: number
  products_active: number
  products_without_images: number
  products_without_description: number
  products_with_schema_markup: number
  issues: Finding[]
}

export interface ShopifyStoreConfigCheckResult extends CheckResult {
  id: 'shopify-store-config'
  store_info: ShopInfo
  theme_info: Theme
  payment_methods: string[]
  shipping_zones: number
  sales_channels_active: string[]
  issues: Finding[]
}

// ── Layer 1 Full Results ─────────────────────────────────────────────────

export interface Layer1Results {
  ran_at: string
  store_domain: string
  all_checks: CheckResult[]
  security: SecurityResult
  performance: PerformanceResult
  accessibility: AccessibilityResult
  shopify_theme: ShopifyThemeCheckResult
  shopify_apps: ShopifyAppsCheckResult
  shopify_checkout: ShopifyCheckoutCheckResult
  shopify_products: ShopifyProductsCheckResult
  shopify_store_config: ShopifyStoreConfigCheckResult
  total_findings: number
  critical_findings: number
  high_findings: number
  medium_findings: number
  low_findings: number
  layer2_queue: Layer2Investigation[]
}

// ── Layer 2: AI-Powered Testing ──────────────────────────────────────────

export interface Layer2Investigation {
  id: string
  type: 'flow' | 'visual' | 'error-context' | 'anomaly' | 'ux' | 'code-driven'
  title: string
  description: string
  priority: 'high' | 'medium' | 'low'
  pages?: string[]
}

export interface Layer2Finding {
  id: string
  investigation_id: string
  status: 'pass' | 'fail' | 'warning'
  summary: string
  details: string
  screenshots: string[]
  issues: Finding[]
}

export interface Layer2Results {
  tested_at: string
  investigations: Layer2Finding[]
  additional_findings: string[]
}

// ── Final Report ─────────────────────────────────────────────────────────

export interface QAReport {
  store_domain: string
  store_name: string
  tested_at: string
  layer1_results: Layer1Results
  layer2_results?: Layer2Results
  summary: ReportSummary
  findings: ReportFinding[]
}

export interface ReportSummary {
  total_findings: number
  critical: number
  high: number
  medium: number
  low: number
  info: number
  go_live_recommendation: 'approved' | 'conditional' | 'blocked'
  blocking_issues: string[]
}

export interface ReportFinding {
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info'
  title: string
  description: string
  location: string
  recommendation: string
  evidence?: string | string[]
}

// ── Logging ──────────────────────────────────────────────────────────────

export interface Logger {
  info(msg: string, data?: any): void
  success(msg: string, data?: any): void
  warn(msg: string, data?: any): void
  error(msg: string, data?: any): void
  debug(msg: string, data?: any): void
  dim(msg: string, data?: any): void
}

export interface CLI {
  command: 'run' | 'merge' | 'init' | 'check-apps'
  config?: string
  url?: string
  adminKey?: string
  adminPassword?: string
  accessToken?: string
  skipBrowser?: boolean
  output?: string
}

// ── Layer 2 Findings ─────────────────────────────────────────────────

export interface Layer2Issue {
  severity: 'blocker' | 'major' | 'minor'
  title: string
  description: string
  location?: string
  how_to_fix?: string
}

export interface Layer2InvestigationResult {
  id: string
  status: 'pass' | 'fail' | 'warning'
  summary: string
  details: string
  screenshots: string[]
  issues: Layer2Issue[]
}

export interface Layer2FindingsFile {
  tested_at: string
  store_domain: string
  investigations: Layer2InvestigationResult[]
  additional_findings?: string[]
}

// ── Regression / Snapshot ────────────────────────────────────────────

export interface FindingFingerprint {
  key: string // `${checkId}::${findingId}`
  checkId: string
  findingId: string
  severity: string
  title: string
}

export interface Snapshot {
  ran_at: string
  store_domain: string
  theme_id?: string
  theme_updated_at?: string
  apps: { handle: string; title: string }[]
  fingerprints: FindingFingerprint[]
  counts: { critical: number; high: number; medium: number; low: number; info: number }
}

export interface RegressionResult {
  hasBaseline: boolean
  baselineRanAt?: string
  newIssues: FindingFingerprint[]
  resolvedIssues: FindingFingerprint[]
  regressed: FindingFingerprint[] // same finding, severity worsened
  themeChanged: boolean
  themeDetail?: string
  appChanges: { added: string[]; removed: string[] }
}

// ── Fixable Issues ───────────────────────────────────────────────────

export interface FixableIssue {
  id: string
  severity: 'critical' | 'high' | 'medium'
  category: 'security' | 'performance' | 'theme' | 'apps' | 'checkout' | 'content' | 'seo' | 'accessibility'
  fix_type: 'admin-setting' | 'code-change' | 'content-edit' | 'app-install'
  title: string
  problem: string
  fix: string
  admin_url?: string
  effort: 'minutes' | 'hours' | 'days'
}
