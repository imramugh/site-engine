#!/usr/bin/env node
import { resolve } from 'node:path'
import { validateThemePackage } from './theme-package.js'

const directory = process.argv[2]
if (!directory || process.argv.length !== 3) {
  process.stderr.write('Usage: site-engine-validate-theme <extracted-package-directory>\n')
  process.exitCode = 64
} else {
  validateThemePackage(resolve(directory)).then(
    result => process.stdout.write(`${JSON.stringify(result)}\n`),
    error => {
      const message = error instanceof Error ? error.message : String(error)
      process.stderr.write(`Theme package validation failed: ${message}\n`)
      process.exitCode = 1
    },
  )
}
