/**
 * Parses every source file and resolves every relative import.
 *
 * `node --check` catches syntax but not a dangling `./foo.mjs`, and a bad
 * relative path in a rarely-taken branch stays invisible until a user hits it.
 * This walks the whole tree instead.
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const ROOT = path.join(import.meta.dirname, '..')
const SRC = path.join(ROOT, 'src')

function walk(dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else if (entry.name.endsWith('.mjs') || entry.name.endsWith('.js')) out.push(full)
  }
  return out
}

const files = [...walk(SRC), ...walk(path.join(ROOT, 'bin'))]
const problems = []

for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' })
  } catch (error) {
    problems.push(`${path.relative(ROOT, file)}: syntax: ${String(error.stderr).split('\n')[1] ?? ''}`)
    continue
  }

  const source = fs.readFileSync(file, 'utf8')
  const dir = path.dirname(file)
  // Static imports, re-exports, and the dynamic import() the CLI uses to defer
  // heavy modules -- a typo in one of those is exactly the invisible kind.
  const specifiers = [
    ...source.matchAll(/(?:^|[^.\w])(?:import|export)\s+[^'"]*?from\s*['"]([^'"]+)['"]/g),
    ...source.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g),
  ].map(match => match[1])

  for (const specifier of specifiers) {
    if (!specifier.startsWith('.')) continue // bare//node: handled by npm install
    const resolved = path.resolve(dir, specifier)
    if (!fs.existsSync(resolved)) {
      problems.push(`${path.relative(ROOT, file)}: unresolved import "${specifier}"`)
    }
  }

  // Checking only that the *file* exists lets a rename slip through: after
  // save-paths.mjs became device-paths.mjs the imports still pointed at a real
  // file while every name they pulled from it had gone. So check the names too.
  for (const match of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"](\.[^'"]+)['"]/g)) {
    const target = path.resolve(dir, match[2])
    if (!fs.existsSync(target)) continue
    const targetSource = fs.readFileSync(target, 'utf8')
    const names = match[1]
      .split(',')
      .map(part => part.trim().split(/\s+as\s+/)[0].trim())
      .filter(Boolean)
    for (const name of names) {
      const exported = new RegExp(
        `export\\s+(?:async\\s+)?(?:function|const|let|var|class)\\s+${name}\\b|` +
        `export\\s*\\{[^}]*\\b${name}\\b[^}]*\\}`,
      ).test(targetSource)
      if (!exported) {
        problems.push(
          `${path.relative(ROOT, file)}: "${name}" is not exported by ${match[2]}`,
        )
      }
    }
  }
}

if (problems.length) {
  console.error(`${problems.length} problem(s):\n`)
  for (const problem of problems) console.error(`  ${problem}`)
  process.exit(1)
}
console.log(`ok: ${files.length} files parsed, all relative imports resolve`)
