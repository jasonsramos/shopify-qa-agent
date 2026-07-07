import * as fs from 'fs/promises'
import path from 'path'
import { logger } from './utils.js'

/**
 * Analyze theme code for custom features
 * Reads Liquid, JSON, and JS files from theme directory
 */
export async function analyzeThemeCode(projectPath: string | undefined): Promise<ThemeAnalysis> {
  const analysis: ThemeAnalysis = {
    hasTheme: false,
    customCheckoutFields: [],
    customPaymentIntegrations: [],
    customSections: [],
    customLogic: [],
    fileCount: 0,
    warnings: [],
  }

  if (!projectPath) {
    return analysis
  }

  try {
    // Check if path exists
    const stats = await fs.stat(projectPath)
    if (!stats.isDirectory()) {
      analysis.warnings.push(`Path is not a directory: ${projectPath}`)
      return analysis
    }

    analysis.hasTheme = true
    logger.debug(`Analyzing theme code at: ${projectPath}`)

    // Find Liquid files
    const liquidFiles = await findFiles(projectPath, '**/*.liquid')
    analysis.fileCount = liquidFiles.length

    if (liquidFiles.length === 0) {
      analysis.warnings.push('No Liquid files found in theme directory')
      return analysis
    }

    // Analyze each file
    for (const file of liquidFiles) {
      const content = await fs.readFile(file, 'utf-8')

      // Check for custom checkout fields
      if (file.includes('checkout') && content.includes('input') || content.includes('field')) {
        const fields = extractFields(content)
        analysis.customCheckoutFields.push(...fields)
      }

      // Check for payment integrations
      if (content.toLowerCase().includes('payment') || content.toLowerCase().includes('stripe')) {
        analysis.customPaymentIntegrations.push({
          file: path.relative(projectPath, file),
          mention: 'payment-related code found',
        })
      }

      // Check for custom sections
      if (file.includes('sections/')) {
        const sectionName = path.basename(file, '.liquid')
        if (!isStandardSection(sectionName)) {
          analysis.customSections.push(sectionName)
        }
      }

      // Check for custom logic
      if (content.includes('for ') || content.includes('if ') || content.includes('assign')) {
        const logicLines = content.split('\n').filter((line) => line.includes('for ') || line.includes('if ') || line.includes('assign'))
        if (logicLines.length > 5) {
          analysis.customLogic.push({
            file: path.relative(projectPath, file),
            complexity: logicLines.length,
          })
        }
      }
    }

    logger.debug(`Theme analysis complete: ${analysis.fileCount} files, ${analysis.customSections.length} custom sections`)
  } catch (err: any) {
    analysis.warnings.push(`Could not analyze theme: ${err.message}`)
  }

  return analysis
}

export interface ThemeAnalysis {
  hasTheme: boolean
  customCheckoutFields: string[]
  customPaymentIntegrations: Array<{ file: string; mention: string }>
  customSections: string[]
  customLogic: Array<{ file: string; complexity: number }>
  fileCount: number
  warnings: string[]
}

/**
 * Find files matching pattern recursively
 */
async function findFiles(dir: string, pattern: string): Promise<string[]> {
  const files: string[] = []
  const isLiquid = pattern.endsWith('*.liquid')

  async function traverse(currentPath: string) {
    try {
      const entries = await fs.readdir(currentPath, { withFileTypes: true })

      for (const entry of entries) {
        const fullPath = path.join(currentPath, entry.name)

        if (entry.isDirectory()) {
          if (!entry.name.startsWith('.') && entry.name !== 'node_modules') {
            await traverse(fullPath)
          }
        } else if (entry.isFile()) {
          if (isLiquid && entry.name.endsWith('.liquid')) {
            files.push(fullPath)
          }
        }
      }
    } catch (err: any) {
      // Skip directories we can't read
    }
  }

  await traverse(dir)
  return files
}

/**
 * Extract custom field names from Liquid
 */
function extractFields(content: string): string[] {
  const fields: string[] = []
  const fieldPattern = /{% form_field|input.*name\s*=\s*["']([^"']+)["']/gi
  let match

  while ((match = fieldPattern.exec(content)) !== null) {
    if (match[1] && !isStandardField(match[1])) {
      fields.push(match[1])
    }
  }

  return [...new Set(fields)] // Remove duplicates
}

/**
 * Check if section is standard Shopify
 */
function isStandardSection(name: string): boolean {
  const standard = [
    'header',
    'footer',
    'hero',
    'featured-products',
    'collection',
    'product',
    'newsletter',
    'testimonials',
    'faq',
    'contact',
  ]
  return standard.some((s) => name.toLowerCase().includes(s))
}

/**
 * Check if field is standard Shopify
 */
function isStandardField(name: string): boolean {
  const standard = [
    'email',
    'password',
    'first_name',
    'last_name',
    'address',
    'phone',
    'company',
    'city',
    'country',
    'province',
    'zip',
    'note',
  ]
  return standard.includes(name.toLowerCase())
}

/**
 * Format theme analysis for display
 */
export function formatThemeAnalysis(analysis: ThemeAnalysis): string {
  if (!analysis.hasTheme) {
    return 'No theme code provided for analysis'
  }

  let output = `📁 Theme Code Analysis:\n`
  output += `  Files scanned: ${analysis.fileCount}\n`

  if (analysis.customCheckoutFields.length > 0) {
    output += `  🛒 Custom checkout fields: ${analysis.customCheckoutFields.join(', ')}\n`
  }

  if (analysis.customPaymentIntegrations.length > 0) {
    output += `  💳 Payment integrations: ${analysis.customPaymentIntegrations.length}\n`
  }

  if (analysis.customSections.length > 0) {
    output += `  📦 Custom sections: ${analysis.customSections.join(', ')}\n`
  }

  if (analysis.customLogic.length > 0) {
    output += `  ⚙️ Complex logic files: ${analysis.customLogic.length}\n`
  }

  if (analysis.warnings.length > 0) {
    output += `  ⚠️ Warnings: ${analysis.warnings.join('; ')}\n`
  }

  return output
}
