import { SiteConfig, CheckResult, Finding } from '../../types.js'
import * as fs from 'fs/promises'
import path from 'path'
import { logger } from '../../utils.js'

interface CustomFeature {
  name: string
  type: 'section' | 'checkout_field' | 'cart_js' | 'integration' | 'extension'
  file: string
  description: string
}

export async function runShopifyCodeAnalysisCheck(config: SiteConfig): Promise<CheckResult> {
  const startTime = Date.now()
  const findings: Finding[] = []

  if (!config.project_path) {
    return {
      id: 'shopify-code-analysis',
      name: 'Shopify Code Analysis',
      status: 'pass',
      duration_ms: Date.now() - startTime,
      findings: [
        {
          id: 'code-analysis-skipped',
          severity: 'info',
          title: 'Code analysis skipped',
          description: 'No project_path provided. Enable to detect custom features for smarter Layer 2 testing.',
          recommendation: 'Add project_path to config.',
        },
      ],
    }
  }

  try {
    const projectPath = config.project_path
    const features = await detectCustomFeatures(projectPath)

    if (features.length === 0) {
      findings.push({
        id: 'code-analysis-no-custom',
        severity: 'info',
        title: 'No custom code detected',
        description: 'Theme appears to be mostly standard. Using default theme features.',
      })
    } else {
      for (const feature of features) {
        findings.push({
          id: `custom-${feature.type}-${feature.name.toLowerCase().replace(/\s+/g, '-')}`,
          severity: 'info',
          title: `Custom ${feature.type.replace(/_/g, ' ')}: ${feature.name}`,
          description: feature.description,
          recommendation: `Layer 2 testing will include verification of this feature (${feature.file})`,
        })
      }
    }

    return {
      id: 'shopify-code-analysis',
      name: 'Shopify Code Analysis',
      status: 'pass',
      duration_ms: Date.now() - startTime,
      findings,
    }
  } catch (err: any) {
    logger.debug(`Code analysis check error: ${err.message}`)
    return {
      id: 'shopify-code-analysis',
      name: 'Shopify Code Analysis',
      status: 'warning',
      duration_ms: Date.now() - startTime,
      findings: [
        {
          id: 'code-analysis-error',
          severity: 'medium',
          title: 'Code analysis failed',
          description: `Could not analyse theme: ${err.message}`,
          recommendation: 'Verify project_path is correct.',
        },
      ],
    }
  }
}

async function detectCustomFeatures(projectPath: string): Promise<CustomFeature[]> {
  const features: CustomFeature[] = []

  try {
    // Detect custom sections
    const sectionsDir = path.join(projectPath, 'sections')
    try {
      const sections = await fs.readdir(sectionsDir)
      for (const section of sections) {
        if (section.endsWith('.liquid')) {
          const name = section.replace('.liquid', '').replace(/-/g, ' ')
          features.push({
            name,
            type: 'section',
            file: `sections/${section}`,
            description: `Custom section "${name}" — will be tested on product/collection pages`,
          })
        }
      }
    } catch (err) {
      // sections dir doesn't exist
    }

    // Detect custom checkout fields
    const themeFile = path.join(projectPath, 'layout/theme.liquid')
    try {
      const content = await fs.readFile(themeFile, 'utf-8')
      if (content.includes('checkout.additionalItem') || content.includes('data-checkout-')) {
        features.push({
          name: 'Custom Checkout Fields',
          type: 'checkout_field',
          file: 'layout/theme.liquid',
          description: 'Custom fields detected in checkout — Layer 2 will verify they appear and accept input',
        })
      }
    } catch (err) {
      // theme.liquid doesn't exist
    }

    // Detect custom cart JS (AJAX cart)
    const assetsDir = path.join(projectPath, 'assets')
    try {
      const assets = await fs.readdir(assetsDir)
      for (const asset of assets) {
        if (asset.includes('cart') && asset.endsWith('.js')) {
          features.push({
            name: 'Custom AJAX Cart',
            type: 'cart_js',
            file: `assets/${asset}`,
            description: 'Custom cart drawer or AJAX functionality — Layer 2 will test add-to-cart flow',
          })
        }
      }
    } catch (err) {
      // assets dir doesn't exist
    }

    // Detect third-party integrations
    const configDir = path.join(projectPath, 'config')
    try {
      const settingsSchema = path.join(configDir, 'settings_schema.json')
      const content = await fs.readFile(settingsSchema, 'utf-8')

      const integrations: { [key: string]: string } = {
        klaviyo: 'Klaviyo email/SMS popup',
        recharge: 'ReCharge subscriptions',
        oberlo: 'Oberlo dropshipping',
        printful: 'Printful print-on-demand',
        spocket: 'Spocket dropshipping',
        subbly: 'Subbly subscriptions',
        'smile-io': 'Smile loyalty program',
        loox: 'Loox reviews',
        yotpo: 'Yotpo reviews',
      }

      for (const [key, desc] of Object.entries(integrations)) {
        if (content.toLowerCase().includes(key)) {
          features.push({
            name: desc.split(' ')[0],
            type: 'integration',
            file: 'config/settings_schema.json',
            description: `${desc} — Layer 2 will verify integration loads correctly`,
          })
        }
      }
    } catch (err) {
      // settings_schema.json doesn't exist
    }

    // Detect checkout extensions
    const extensionsDir = path.join(projectPath, 'extensions')
    try {
      const exts = await fs.readdir(extensionsDir)
      if (exts.length > 0) {
        features.push({
          name: `Checkout Extensions (${exts.length})`,
          type: 'extension',
          file: `extensions/`,
          description: `${exts.length} checkout extension(s) detected — Layer 2 will test checkout flow with extensions active`,
        })
      }
    } catch (err) {
      // extensions dir doesn't exist
    }
  } catch (err) {
    logger.debug(`Error detecting features: ${err}`)
  }

  return features
}
