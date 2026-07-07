import { SiteConfig, CheckResult, Finding } from '../../types.js'
import * as fs from 'fs/promises'
import path from 'path'
import { logger } from '../../utils.js'

export async function runShopifyCodeReviewCheck(config: SiteConfig): Promise<CheckResult> {
  const startTime = Date.now()
  const findings: Finding[] = []

  if (!config.project_path) {
    return {
      id: 'shopify-code-review',
      name: 'Shopify Code Review',
      status: 'pass',
      duration_ms: Date.now() - startTime,
      findings: [
        {
          id: 'code-review-skipped',
          severity: 'info',
          title: 'Code review skipped',
          description: 'No project_path provided in config. Set project_path to scan theme code for security/performance issues.',
          recommendation: 'Add project_path to config to enable code review.',
        },
      ],
    }
  }

  // project_path is a GitHub URL — local file scanning doesn't apply here
  if (/^https?:\/\//i.test(config.project_path)) {
    return {
      id: 'shopify-code-review',
      name: 'Shopify Code Review',
      status: 'pass',
      duration_ms: Date.now() - startTime,
      findings: [
        {
          id: 'code-review-github',
          severity: 'info',
          title: 'Code review handled by Layer 2 GitHub analysis',
          description: 'project_path is a GitHub URL — theme code is analysed by the Layer 2 GitHub analyzer instead of local file scanning.',
        },
      ],
    }
  }

  try {
    const projectPath = config.project_path
    const codeFiles = await scanThemeFiles(projectPath)

    // Scan each file for issues
    for (const file of codeFiles) {
      try {
        const content = await fs.readFile(file, 'utf-8')
        const relPath = path.relative(projectPath, file)

        // Security checks
        if (content.includes('{{ ') && !content.includes('{{ ') && content.includes(' }}')) {
          // Check for unescaped variables
          const unescapedVars = content.match(/\{\{\s*\w+\s*\}\}/g) || []
          if (unescapedVars.length > 0) {
            findings.push({
              id: `xss-unescaped-${relPath.replace(/[^a-z0-9]/gi, '-')}`,
              severity: 'high',
              title: `Potential XSS: unescaped variable in ${relPath}`,
              description: `Found ${unescapedVars.length} unescaped Liquid variables that could render user input without escaping.`,
              recommendation: 'Use | escape filter: {{ variable | escape }}',
              evidence: relPath,
            })
          }
        }

        // Check for hardcoded API keys or secrets
        if (
          /(['"]sk_[a-z0-9]{20,}['"])/i.test(content) ||
          /(['"]pk_[a-z0-9]{20,}['"])/i.test(content) ||
          /(api[_-]?key|secret|password)\s*[:=]\s*['"][^'"]{15,}['"]/i.test(content)
        ) {
          findings.push({
            id: `hardcoded-secret-${relPath.replace(/[^a-z0-9]/gi, '-')}`,
            severity: 'critical',
            title: `Hardcoded secret in ${relPath}`,
            description: 'Found what appears to be a hardcoded API key or secret. This is a critical security issue.',
            recommendation: 'Remove hardcoded secrets. Use environment variables or Shopify metafields instead.',
            evidence: relPath,
          })
        }

        // Performance anti-patterns
        if (file.endsWith('.liquid') && content.includes('for product in collections.all.products')) {
          findings.push({
            id: `n-plus-1-${relPath.replace(/[^a-z0-9]/gi, '-')}`,
            severity: 'high',
            title: `N+1 query pattern in ${relPath}`,
            description: 'Loop iterates over collections.all.products which loads ALL products into memory. This kills performance on large stores.',
            recommendation: 'Use paginate: {% paginate collection.products by 50 %}...{% endpaginate %}',
            evidence: relPath,
          })
        }

        // Deprecated Liquid syntax
        if (content.includes('{% include ')) {
          findings.push({
            id: `deprecated-include-${relPath.replace(/[^a-z0-9]/gi, '-')}`,
            severity: 'medium',
            title: `Deprecated {% include %} in ${relPath}`,
            description: 'Uses deprecated {% include %} which leaks variable scope. Shopify now recommends {% render %}.',
            recommendation: 'Replace {% include %} with {% render %} for better performance and security.',
            evidence: relPath,
          })
        }

        // Check for inline styles/scripts (performance issue)
        if (content.includes('<script>') || content.includes('<style>')) {
          findings.push({
            id: `inline-code-${relPath.replace(/[^a-z0-9]/gi, '-')}`,
            severity: 'medium',
            title: `Inline CSS/JS in ${relPath}`,
            description: 'Found inline <script> or <style> tags. These should be external assets for caching.',
            recommendation: 'Move to separate asset files in assets/ directory.',
            evidence: relPath,
          })
        }

        // Check for missing app injection hook
        if (file.endsWith('layout/theme.liquid')) {
          if (!content.includes('{{ content_for_header }}')) {
            findings.push({
              id: 'missing-content-for-header',
              severity: 'high',
              title: 'Missing {{ content_for_header }} in layout/theme.liquid',
              description: 'Apps cannot inject scripts. This breaks app functionality.',
              recommendation: 'Add {{ content_for_header }} in the <head> tag of layout/theme.liquid',
              evidence: 'layout/theme.liquid',
            })
          }

          if (!content.includes('{{ content_for_layout }}')) {
            findings.push({
              id: 'missing-content-for-layout',
              severity: 'high',
              title: 'Missing {{ content_for_layout }} in layout/theme.liquid',
              description: 'Page templates cannot render. This is a critical issue.',
              recommendation: 'Add {{ content_for_layout }} in the body of layout/theme.liquid',
              evidence: 'layout/theme.liquid',
            })
          }
        }

        // Check for hardcoded myshopify.com URLs
        if (content.includes('.myshopify.com')) {
          findings.push({
            id: `hardcoded-myshopify-${relPath.replace(/[^a-z0-9]/gi, '-')}`,
            severity: 'medium',
            title: `Hardcoded .myshopify.com URL in ${relPath}`,
            description: 'Found hardcoded store domain. This breaks custom domain support.',
            recommendation: 'Use {{ shop.url }} or Shopify liquid variables instead.',
            evidence: relPath,
          })
        }
      } catch (err) {
        logger.debug(`Could not scan ${file}: ${err}`)
      }
    }

    if (findings.length === 0) {
      findings.push({
        id: 'code-review-good',
        severity: 'info',
        title: 'Code review: No critical issues found',
        description: `Scanned ${codeFiles.length} theme files. No major security or performance issues detected.`,
      })
    }

    return {
      id: 'shopify-code-review',
      name: 'Shopify Code Review',
      status: findings.some(f => f.severity === 'critical') ? 'fail' : findings.some(f => f.severity === 'high') ? 'warning' : 'pass',
      duration_ms: Date.now() - startTime,
      findings,
    }
  } catch (err: any) {
    logger.debug(`Code review check error: ${err.message}`)
    return {
      id: 'shopify-code-review',
      name: 'Shopify Code Review',
      status: 'warning',
      duration_ms: Date.now() - startTime,
      findings: [
        {
          id: 'code-review-error',
          severity: 'medium',
          title: 'Code review failed',
          description: `Could not scan theme files: ${err.message}`,
          recommendation: 'Verify project_path is correct and readable.',
        },
      ],
    }
  }
}

async function scanThemeFiles(projectPath: string): Promise<string[]> {
  const files: string[] = []
  const extensions = ['.liquid', '.js', '.css', '.json']

  async function walk(dir: string) {
    const entries = await fs.readdir(dir, { withFileTypes: true })

    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith('.')) {
        await walk(path.join(dir, entry.name))
      } else if (entry.isFile() && extensions.some(ext => entry.name.endsWith(ext))) {
        files.push(path.join(dir, entry.name))
      }
    }
  }

  try {
    await walk(projectPath)
  } catch (err) {
    logger.debug(`Error walking project path: ${err}`)
  }

  return files.slice(0, 100) // Limit to first 100 files for performance
}
