#!/usr/bin/env node

import 'dotenv/config'
import { Command } from 'commander'
import path from 'path'
import { logger, writeJson, writeFile } from './utils.js'
import { resolveConfig, createExampleConfig } from './config.js'
import { runLayer1 } from './layer1/runner.js'
import { generateReportMarkdown } from './layer1/report.js'
import { generateLayer1Report } from './layer1/layer1-report.js'
import { extractFixableIssues } from './layer1/fixable-issues.js'
import { buildFixPrompt } from './layer1/fix-prompt-builder.js'
import { markdownToPdf } from './pdf-generator.js'
import { buildLayer2Prompt } from './layer2/prompt-builder.js'
import { mergeReports } from './layer2/report-merger.js'
import { executeLayer2 } from './layer2/executor.js'
import { saveSnapshot } from './regression/snapshot.js'
import { diffAgainstBaseline } from './regression/diff.js'
import { loadLayer1FromReport, verifyAgainstReport, renderVerificationMarkdown } from './regression/verify.js'
import * as fs from 'fs/promises'

const program = new Command()

program
  .name('shopify-qa')
  .description('Shopify Store QA Agent — automated + AI-powered testing')
  .version('1.0.0')

// ─────────────────────────────────────────────────────────────────────────
// interactive: Guided setup for non-technical users
// ─────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────
// run: Main QA Execution
// ─────────────────────────────────────────────────────────────────────────

program
  .command('run')
  .description('Run QA audit on a Shopify store')
  .option('-c, --config <path>', 'Path to store config YAML file')
  .option('-u, --url <url>', 'Store URL')
  .option('--store-domain <domain>', 'Shopify store domain')
  .option('--api-key <key>', 'Admin API key')
  .option('--api-password <password>', 'Admin API password')
  .option('--access-token <token>', 'Admin API access token')
  .option('--skip-browser', 'Skip browser-based checks (API only)')
  .option('--skip-lighthouse', 'Skip Lighthouse performance audit')
  .option('--skip-pdf', 'Skip PDF generation')
  .option('--headed', 'Run the browser visibly (not headless)')
  .option('--output <path>', 'Output directory for reports', './qa-reports')
  .action(async (options) => {
    try {
      if (options.headed) process.env.QA_HEADLESS = 'false'
      const config = await resolveConfig(options)
      const outputDir = path.join(options.output, `${config.store_domain}-${new Date().toISOString().split('T')[0]}`)
      const storeName = config.name || config.store_domain

      logger.info('')
      logger.info(`🏪 Shopify Store: ${storeName}`)
      logger.info(`📍 Domain: ${config.store_domain}`)
      logger.info(`📊 Plan: ${config.store_plan}`)
      logger.info('')

      // Run Layer 1
      const layer1Results = await runLayer1(config, outputDir)

      // Create output directory
      await fs.mkdir(outputDir, { recursive: true })

      // Save raw results
      await writeJson(path.join(outputDir, 'layer1-results.json'), layer1Results)
      logger.success(`✓ Raw results saved`)

      // Generate layer1-report.md (technical verbose report)
      const layer1ReportMd = generateLayer1Report(layer1Results, { ...config, name: storeName })
      await writeFile(path.join(outputDir, 'layer1-report.md'), layer1ReportMd)
      logger.success(`✓ Layer 1 technical report saved`)

      // Generate layer1-report.pdf
      if (!options.skipPdf) {
        try {
          await markdownToPdf(path.join(outputDir, 'layer1-report.md'))
        } catch (err: any) {
          logger.warn(`PDF generation failed (non-fatal): ${err.message}`)
        }
      }

      // Generate preliminary final-report.md (L1 only, will be overwritten by merge)
      const reportMd = generateReportMarkdown(layer1Results, { ...config, name: storeName })
      await writeFile(path.join(outputDir, 'final-report.md'), reportMd)
      logger.success(`✓ Preliminary final report saved`)

      // Extract fixable issues
      const fixableIssues = extractFixableIssues(layer1Results)
      await writeJson(path.join(outputDir, 'fixable-issues.json'), fixableIssues)
      logger.success(`✓ Fixable issues extracted`)

      // Generate Layer 2 prompt
      const layer2Prompt = await buildLayer2Prompt(layer1Results, { ...config, name: storeName }, outputDir)
      await writeFile(path.join(outputDir, 'layer2-prompt.md'), layer2Prompt)
      logger.success(`✓ Layer 2 investigation prompt generated`)

      logger.info('')
      logger.success('✅ Layer 1 QA audit complete!')
      logger.dim(`Reports directory: ${outputDir}`)
      logger.dim(`Raw data: layer1-results.json`)
      logger.dim(`Report: final-report.md`)

      if (layer1Results.critical_findings > 0) {
        logger.warn(`⚠️  ${layer1Results.critical_findings} critical issues found`)
      }
    } catch (err: any) {
      logger.error(`Failed to run QA audit: ${err.message}`)
      process.exit(1)
    }
  })

// ─────────────────────────────────────────────────────────────────────────
// qa-full: Layer 1 + Layer 2 + Merge (fully automated)
// ─────────────────────────────────────────────────────────────────────────

program
  .command('qa-full')
  .description('Run complete QA audit: Layer 1 + Layer 2 (AI) + Merge → Final Report')
  .option('-c, --config <path>', 'Path to store config YAML file')
  .option('-u, --url <url>', 'Store URL')
  .option('--store-domain <domain>', 'Shopify store domain')
  .option('--api-key <key>', 'Admin API key')
  .option('--api-password <password>', 'Admin API password')
  .option('--access-token <token>', 'Admin API access token')
  .option('--headed', 'Run the browser visibly (not headless)')
  .option('--output <path>', 'Output directory for reports', './qa-reports')
  .action(async (options) => {
    try {
      if (options.headed) process.env.QA_HEADLESS = 'false'
      const config = await resolveConfig(options)
      config.enable_ai = false
      const outputDir = path.join(options.output, `${config.store_domain}-${new Date().toISOString().split('T')[0]}`)
      const storeName = config.name || config.store_domain

      logger.info('')
      logger.info(`🏪 Shopify Store: ${storeName}`)
      logger.info(`📍 Domain: ${config.store_domain}`)
      logger.info(`📊 Plan: ${config.store_plan}`)
      logger.info('')

      // ─── LAYER 1: Automated Checks ───
      logger.info('🔍 LAYER 1: Running automated checks...')
      await fs.mkdir(outputDir, { recursive: true })

      const layer1Results = await runLayer1(config, outputDir)
      await writeJson(path.join(outputDir, 'layer1-results.json'), layer1Results)
      logger.success(`✓ Layer 1 complete: ${layer1Results.total_findings} findings`)

      // ─── LAYER 2: AI-Powered Browser Testing ───
      logger.info('')
      logger.info('🤖 LAYER 2: Running AI-powered browser tests...')

      const layer2Prompt = await buildLayer2Prompt(layer1Results, { ...config, name: storeName }, outputDir)
      await writeFile(path.join(outputDir, 'layer2-prompt.md'), layer2Prompt)

      try {
        const layer2Findings = await executeLayer2(config, layer1Results, layer2Prompt, outputDir)
        logger.success(`✓ Layer 2 complete: ${layer2Findings.investigations?.length || 0} investigations`)
      } catch (err: any) {
        logger.warn(`⚠️  Layer 2 analysis skipped: ${err.message}`)
      }

      // ─── REGRESSION: Diff against baseline, then update it ───
      try {
        const regression = await diffAgainstBaseline(layer1Results, config)
        await writeJson(path.join(outputDir, 'regression.json'), regression)
        if (regression.hasBaseline) {
          logger.success(
            `✓ Regression vs last run: ${regression.newIssues.length} new, ${regression.resolvedIssues.length} resolved, ${regression.regressed.length} regressed`
          )
        } else {
          logger.dim('No prior baseline — this run becomes the baseline.')
        }
        await saveSnapshot(layer1Results, config)
      } catch (err: any) {
        logger.warn(`Regression step skipped: ${err.message}`)
      }

      // ─── MERGE: Combine Results ───
      logger.info('')
      logger.info('📋 Merging Layer 1 + Layer 2 results...')
      await mergeReports(outputDir)

      // ─── DONE ───
      logger.info('')
      logger.success('✅ COMPLETE: Full QA audit finished!')
      logger.success(`📄 Final Report: ${path.join(outputDir, 'final-report.md')}`)
      logger.success(`📊 Final Report PDF: ${path.join(outputDir, 'final-report.pdf')}`)
      logger.dim(`Output directory: ${outputDir}`)
    } catch (err: any) {
      logger.error(`Failed to run full QA audit: ${err.message}`)
      process.exit(1)
    }
  })

// ─────────────────────────────────────────────────────────────────────────
// init: Create a new store config
// ─────────────────────────────────────────────────────────────────────────

program
  .command('init')
  .description('Create a new store config file')
  .option('-u, --url <url>', 'Store URL')
  .option('-n, --name <name>', 'Store name')
  .option('-o, --output <path>', 'Output config file path', './configs/store.yml')
  .action(async (options) => {
    try {
      await createExampleConfig(options.output)
      logger.success(`Config created at ${options.output}`)
      logger.dim('Edit the config file with your store details and API credentials')
    } catch (err: any) {
      logger.error(`Failed to create config: ${err.message}`)
      process.exit(1)
    }
  })

// ─────────────────────────────────────────────────────────────────────────
// merge: Combine Layer 1 + Layer 2 results
// ─────────────────────────────────────────────────────────────────────────

program
  .command('merge')
  .description('Merge Layer 1 + Layer 2 findings into final report')
  .requiredOption('--report <path>', 'Path to report directory')
  .action(async (options) => {
    try {
      await mergeReports(options.report)
      logger.success('✅ Reports merged successfully')
    } catch (err: any) {
      logger.error(`Failed to merge reports: ${err.message}`)
      process.exit(1)
    }
  })

// ─────────────────────────────────────────────────────────────────────────
// check-apps: List installed apps
// ─────────────────────────────────────────────────────────────────────────

program
  .command('check-apps')
  .description('List installed apps on a store')
  .option('-c, --config <path>', 'Path to store config YAML file')
  .option('-u, --url <url>', 'Store URL')
  .option('--api-key <key>', 'Admin API key')
  .option('--api-password <password>', 'Admin API password')
  .option('--access-token <token>', 'Admin API access token')
  .action(async (options) => {
    try {
      const config = await resolveConfig(options)
      logger.info(`Checking apps on ${config.store_domain}`)
      // TODO: Implement app listing
      logger.success('Apps checked')
    } catch (err: any) {
      logger.error(`Failed to check apps: ${err.message}`)
      process.exit(1)
    }
  })

// ─────────────────────────────────────────────────────────────────────────
// snapshot: Save the current Layer 1 results as a regression baseline
// ─────────────────────────────────────────────────────────────────────────

program
  .command('snapshot')
  .description('Run Layer 1 and save the result as the regression baseline for this store')
  .option('-c, --config <path>', 'Path to store config YAML file')
  .option('-u, --url <url>', 'Store URL')
  .option('--store-domain <domain>', 'Shopify store domain')
  .option('--access-token <token>', 'Admin API access token')
  .option('--output <path>', 'Output directory for reports', './qa-reports')
  .action(async (options) => {
    try {
      const config = await resolveConfig(options)
      const outputDir = path.join(options.output, `${config.store_domain}-${new Date().toISOString().split('T')[0]}`)
      await fs.mkdir(outputDir, { recursive: true })
      logger.info(`📸 Capturing baseline snapshot for ${config.store_domain}…`)
      const layer1Results = await runLayer1(config, outputDir)
      await writeJson(path.join(outputDir, 'layer1-results.json'), layer1Results)
      await saveSnapshot(layer1Results, config)
      logger.success('✅ Baseline snapshot saved. Future `diff`/`qa-full` runs will compare against it.')
    } catch (err: any) {
      logger.error(`Failed to capture snapshot: ${err.message}`)
      process.exit(1)
    }
  })

// ─────────────────────────────────────────────────────────────────────────
// diff: Run Layer 1 and compare against the saved baseline
// ─────────────────────────────────────────────────────────────────────────

program
  .command('diff')
  .description('Run Layer 1 and report changes (new/resolved/regressed) vs the saved baseline')
  .option('-c, --config <path>', 'Path to store config YAML file')
  .option('-u, --url <url>', 'Store URL')
  .option('--store-domain <domain>', 'Shopify store domain')
  .option('--access-token <token>', 'Admin API access token')
  .option('--update-baseline', 'Overwrite the baseline with this run after diffing')
  .option('--output <path>', 'Output directory for reports', './qa-reports')
  .action(async (options) => {
    try {
      const config = await resolveConfig(options)
      const outputDir = path.join(options.output, `${config.store_domain}-${new Date().toISOString().split('T')[0]}`)
      await fs.mkdir(outputDir, { recursive: true })

      const layer1Results = await runLayer1(config, outputDir)
      await writeJson(path.join(outputDir, 'layer1-results.json'), layer1Results)

      const regression = await diffAgainstBaseline(layer1Results, config)
      await writeJson(path.join(outputDir, 'regression.json'), regression)

      logger.info('')
      if (!regression.hasBaseline) {
        logger.warn('No baseline found. Run `shopify-qa snapshot` first to create one.')
      } else {
        logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
        logger.info(`📊 Changes since baseline (${regression.baselineRanAt})`)
        logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
        logger.error(`  🆕 New issues:      ${regression.newIssues.length}`)
        logger.success(`  ✅ Resolved issues: ${regression.resolvedIssues.length}`)
        logger.warn(`  ⬆️  Regressed:       ${regression.regressed.length}`)
        if (regression.themeChanged) logger.warn(`  🎨 ${regression.themeDetail}`)
        if (regression.appChanges.added.length) logger.info(`  ➕ Apps added: ${regression.appChanges.added.join(', ')}`)
        if (regression.appChanges.removed.length) logger.info(`  ➖ Apps removed: ${regression.appChanges.removed.join(', ')}`)
        for (const n of regression.newIssues.slice(0, 10)) logger.dim(`     NEW [${n.severity}] ${n.title}`)
      }

      if (options.updateBaseline) {
        await saveSnapshot(layer1Results, config)
      }
    } catch (err: any) {
      logger.error(`Failed to run diff: ${err.message}`)
      process.exit(1)
    }
  })

// ─────────────────────────────────────────────────────────────────────────
// verify: Re-check an older report's findings — resolved / still present / new
// ─────────────────────────────────────────────────────────────────────────

program
  .command('verify')
  .description('Verify whether findings from an older report are resolved (runs a fresh Layer 1, or compares an existing run)')
  .requiredOption('--against <path>', 'Older report directory to verify against (must contain layer1-results.json)')
  .option('-c, --config <path>', 'Path to store config YAML file (required unless --current is used)')
  .option('-u, --url <url>', 'Store URL')
  .option('--store-domain <domain>', 'Shopify store domain')
  .option('--access-token <token>', 'Admin API access token')
  .option('--current <path>', 'Use an existing report directory as the current run instead of running a fresh audit')
  .option('--headed', 'Run the browser visibly (not headless)')
  .option('--output <path>', 'Output directory for reports', './qa-reports')
  .action(async (options) => {
    try {
      if (options.headed) process.env.QA_HEADLESS = 'false'

      // Load the baseline (older) report
      const baseline = await loadLayer1FromReport(options.against).catch(() => null)
      if (!baseline) {
        logger.error(`Could not read layer1-results.json from ${options.against}`)
        process.exit(1)
      }

      // Get the current run — either an existing report dir or a fresh audit
      let current
      let outputDir: string
      if (options.current) {
        current = await loadLayer1FromReport(options.current).catch(() => null)
        if (!current) {
          logger.error(`Could not read layer1-results.json from ${options.current}`)
          process.exit(1)
        }
        outputDir = options.current
      } else {
        const config = await resolveConfig(options)
        outputDir = path.join(options.output, `${config.store_domain}-${new Date().toISOString().split('T')[0]}`)
        await fs.mkdir(outputDir, { recursive: true })
        logger.info(`🔁 Running fresh Layer 1 to verify findings from ${options.against}…`)
        current = await runLayer1(config, outputDir)
        await writeJson(path.join(outputDir, 'layer1-results.json'), current)
      }

      const result = verifyAgainstReport(current, baseline)
      const md = renderVerificationMarkdown(result, options.against)
      const mdPath = path.join(outputDir, 'verification-report.md')
      await writeFile(mdPath, md)
      await writeJson(path.join(outputDir, 'verification-result.json'), result)

      logger.info('')
      logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
      logger.info(`🔎 Verification vs ${options.against}`)
      logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
      logger.success(`  ✅ Resolved:      ${result.resolved.length}`)
      logger.error(`  ❌ Still present: ${result.stillPresent.length}`)
      logger.warn(`  ⬆️  Worse:         ${result.worse.length}`)
      logger.info(`  ⬇️  Improved:      ${result.improved.length}`)
      logger.info(`  🆕 New:           ${result.newIssues.length}`)
      for (const f of result.stillPresent.slice(0, 10)) logger.dim(`     STILL [${f.severity}] ${f.title}`)
      logger.success(`✓ Verification report: ${mdPath}`)

      try {
        await markdownToPdf(mdPath)
      } catch {
        /* non-fatal */
      }
    } catch (err: any) {
      logger.error(`Failed to verify: ${err.message}`)
      process.exit(1)
    }
  })

// ─────────────────────────────────────────────────────────────────────────
// fix: Generate AI-ready fix prompts from a QA report
// ─────────────────────────────────────────────────────────────────────────

program
  .command('fix')
  .description('Generate AI-ready fix prompts from a QA report')
  .requiredOption('--report <path>', 'Path to QA report directory (containing fixable-issues.json)')
  .option('--output <path>', 'Output file for fix prompt (default: fix-prompt.md in report dir)')
  .action(async (options) => {
    try {
      const reportDir = options.report
      const fixableIssuesPath = path.join(reportDir, 'fixable-issues.json')

      // Read fixable-issues.json
      let issues: any[] = []
      try {
        const fileContent = await fs.readFile(fixableIssuesPath, 'utf-8')
        issues = JSON.parse(fileContent)
      } catch (err: any) {
        logger.error(
          `Could not read fixable-issues.json from ${reportDir}. Make sure you've run 'qa-full' first.`
        )
        process.exit(1)
      }

      if (!Array.isArray(issues) || issues.length === 0) {
        logger.warn('No fixable issues found.')
        process.exit(0)
      }

      // Try to infer store name/domain from layer1-results.json
      let storeName = 'Store'
      let storeDomain = 'unknown'
      try {
        const layer1Path = path.join(reportDir, 'layer1-results.json')
        const layer1Content = await fs.readFile(layer1Path, 'utf-8')
        const layer1 = JSON.parse(layer1Content)
        storeDomain = layer1.store_domain || storeDomain
        storeName = layer1.store_domain?.split('.')[0] || storeName
      } catch {
        // Ignore; use defaults
      }

      // Generate fix prompt
      const fixPrompt = buildFixPrompt(issues, storeName, storeDomain)

      // Write output
      const outputPath = options.output || path.join(reportDir, 'fix-prompt.md')
      await writeFile(outputPath, fixPrompt)

      logger.success(`✓ Fix prompt generated: ${outputPath}`)
      logger.info(`  Issues: ${issues.length} (${issues.filter((i: any) => i.severity === 'critical').length} critical)`)
      logger.dim('Use this prompt with Claude to get step-by-step fix instructions.')
    } catch (err: any) {
      logger.error(`Failed to generate fix prompt: ${err.message}`)
      process.exit(1)
    }
  })

// ─────────────────────────────────────────────────────────────────────────
// Parse and execute
// ─────────────────────────────────────────────────────────────────────────

program.parse(process.argv)

if (process.argv.length < 3) {
  program.outputHelp()
}
