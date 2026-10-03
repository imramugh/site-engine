import { readdir, readFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

type Manifest = {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
}

type Rule = {
  packageName: string
  prohibited: string[]
}

const rules: Rule[] = [
  { packageName: '@site-engine/theme-starter', prohibited: ['@site-engine/cms', '@site-engine/engine'] },
  { packageName: '@site-engine/contract', prohibited: ['@site-engine/cms', '@site-engine/engine', '@site-engine/theme-starter'] },
]

const sourceExtension = /\.(?:astro|[cm]?[jt]sx?)$/
const moduleSpecifier = /\b(?:from\s*|import\s*\(\s*|require\s*\(\s*|import\s*)['"]([^'"\r\n]+)['"]/g

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return sourceExtension.test(entry.name) ? [path] : []
  }))
  return files.flat()
}

function packageFolder(packageName: string): string {
  return packageName.split('/')[1]!
}

function manifestDependencies(manifest: Manifest): Record<string, string>[] {
  return [manifest.dependencies ?? {}, manifest.devDependencies ?? {}, manifest.peerDependencies ?? {}, manifest.optionalDependencies ?? {}]
}

function isProhibited(specifier: string, dependency: string): boolean {
  return specifier === dependency || specifier.startsWith(`${dependency}/`)
}

/**
 * Returns every public-package boundary violation found below a workspace root.
 * Only contract and starter source trees are scanned, so fixtures in this checks
 * package cannot be mistaken for imports.
 */
export async function inspectBoundaries(root: string): Promise<string[]> {
  const errors: string[] = []

  for (const rule of rules) {
    const packageRoot = join(root, 'packages', packageFolder(rule.packageName))
    const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')) as Manifest

    for (const dependency of rule.prohibited) {
      if (manifestDependencies(manifest).some((section) => dependency in section)) {
        errors.push(`${rule.packageName} must not declare ${dependency}`)
      }
    }

    for (const file of await sourceFiles(join(packageRoot, 'src'))) {
      const source = await readFile(file, 'utf8')
      for (const match of source.matchAll(moduleSpecifier)) {
        const specifier = match[1]!
        for (const dependency of rule.prohibited) {
          if (isProhibited(specifier, dependency)) {
            errors.push(`${relative(root, file)} imports prohibited ${specifier}`)
          }
        }

        if (specifier.startsWith('.')) {
          const destination = relative(packageRoot, resolve(dirname(file), specifier))
          if (destination === '..' || destination.startsWith('../') || destination.startsWith('..\\')) {
            errors.push(`${relative(root, file)} imports outside its package: ${specifier}`)
          }
        }
      }
    }
  }

  return errors
}

export async function assertBoundaries(root = process.cwd()): Promise<void> {
  const errors = await inspectBoundaries(root)
  if (errors.length > 0) throw new Error(`Dependency boundary violations:\n${errors.join('\n')}`)
}

async function main(): Promise<void> {
  await assertBoundaries()
  console.log('workspace dependency boundaries are valid')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
