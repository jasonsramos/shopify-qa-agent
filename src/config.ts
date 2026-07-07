import * as fs from 'fs/promises'
import * as yaml from 'js-yaml'
import { SiteConfig } from './types.js'
import { logger } from './utils.js'

const DEFAULT_CONFIG: Partial<SiteConfig> = {
  test_checkout: true,
  test_on_mobile: true,
  critical_apps: [],
  skip_apps_check: [],
  known_issues: [],
  key_pages: ['/'],
  max_links_to_crawl: 50,
  timeout_ms: 30000,
}

/**
 * Load configuration from a YAML file
 */
export async function loadConfigFromFile(filepath: string): Promise<SiteConfig> {
  try {
    const content = await fs.readFile(filepath, 'utf-8')
    const parsed = yaml.load(content) as Partial<SiteConfig>
    const config = { ...DEFAULT_CONFIG, ...parsed } as SiteConfig

    // Validate required fields
    if (!config.store_domain) {
      throw new Error('store_domain is required in config')
    }
    // Admin API is optional - some checks will skip if not provided
    if (!config.admin_access_token && (!config.admin_api_key || !config.admin_api_password)) {
      logger.warn('No admin credentials provided - Admin API checks will be skipped')
      config.admin_access_token = ''
    }

    // Build store_url if not provided
    if (!config.store_url) {
      config.store_url = `https://${config.store_domain}`
    }

    return config
  } catch (err: any) {
    throw new Error(`Failed to load config from ${filepath}: ${err.message}`)
  }
}

/**
 * Create a config from CLI options
 */
export function configFromCLI(options: any): Partial<SiteConfig> {
  const config: Partial<SiteConfig> = {}

  if (options.url) {
    try {
      const url = new URL(options.url)
      config.store_domain = url.host  // always set — not just for myshopify.com
      config.store_url = options.url
    } catch {
      config.store_url = options.url
    }
  }

  if (options.storeDomain) {
    config.store_domain = options.storeDomain
  }

  if (options.adminKey) {
    config.admin_api_key = options.adminKey
  }

  if (options.adminPassword) {
    config.admin_api_password = options.adminPassword
  }

  if (options.accessToken) {
    config.admin_access_token = options.accessToken
  }

  return { ...DEFAULT_CONFIG, ...config }
}

/**
 * Find and load a matching config based on store domain
 */
export async function findMatchingConfig(storeDomain: string): Promise<SiteConfig | null> {
  try {
    const configDir = './configs'
    const files = await fs.readdir(configDir)

    for (const file of files) {
      if (!file.endsWith('.yml') && !file.endsWith('.yaml')) continue

      try {
        const config = await loadConfigFromFile(`${configDir}/${file}`)
        if (config.store_domain === storeDomain) {
          logger.info(`Found matching config for ${storeDomain}: ${file}`)
          return config
        }
      } catch {
        // Skip files that fail to parse
        continue
      }
    }

    return null
  } catch {
    return null
  }
}

/**
 * Resolve config from options or file or CLI
 */
export async function resolveConfig(
  options: any
): Promise<SiteConfig> {
  // Priority:
  // 1. Explicit config file
  // 2. CLI options
  // 3. Find matching config by domain
  // 4. Fallback to CLI options

  let config: Partial<SiteConfig> = {}

  // If config file specified, load it
  if (options.config) {
    config = await loadConfigFromFile(options.config)
    return config as SiteConfig
  }

  // Try to build from CLI options first to get domain
  config = configFromCLI(options)

  if (config.store_domain) {
    // Try to find matching config file
    const matchingConfig = await findMatchingConfig(config.store_domain)
    if (matchingConfig) {
      // Merge CLI options over matched config
      return { ...matchingConfig, ...config } as SiteConfig
    }
  }

  // Validate minimal config
  if (!config.store_domain && !config.store_url) {
    throw new Error('Either --config, --store-domain, or --url is required')
  }

  // Admin API is optional - some checks will skip if not provided
  if (!config.admin_access_token && (!config.admin_api_key || !config.admin_api_password)) {
    logger.warn('No admin credentials provided - Admin API checks will be skipped')
    config.admin_access_token = ''
  }

  // Ensure store_url
  if (!config.store_url) {
    config.store_url = `https://${config.store_domain}`
  }

  return config as SiteConfig
}

/**
 * Create an example config file
 */
export async function createExampleConfig(outputPath: string): Promise<void> {
  const example: SiteConfig = {
    name: 'My Shopify Store',
    store_domain: 'mystore.myshopify.com',
    store_url: 'https://mystore.myshopify.com',
    admin_api_key: 'your-api-key-here',
    admin_api_password: 'your-api-password-here',
    store_type: 'standard',
    store_plan: 'advanced',
    theme_name: 'Dawn',
    test_checkout: true,
    test_on_mobile: true,
    critical_apps: ['Recharge', 'Klaviyo'],
    skip_apps_check: [],
    known_issues: ['Homepage hero loads slowly (CDN issue)'],
    key_pages: ['/', '/products', '/cart', '/checkout'],
    max_links_to_crawl: 50,
    timeout_ms: 30000,
  }

  const yaml_str = yaml.dump(example, { indent: 2 })
  await fs.writeFile(outputPath, yaml_str, 'utf-8')
  logger.success(`Created example config: ${outputPath}`)
}
