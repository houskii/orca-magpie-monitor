import { cpSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const target = join(root, '.local', 'package')
const build = join(root, '.local', 'native-build')
mkdirSync(build, { recursive: true })
// Inline SVGs avoid WebKit's file-URL restrictions on external CSS masks.
const icons = Object.fromEntries(['claude', 'gpt', 'deepseek', 'zap'].map(name =>
  [name, readFileSync(join(root, 'native', 'icons', `${name}.svg`), 'utf8')]))
writeFileSync(join(root, 'native', 'icons', 'icons.js'), `window.modelIcons = ${JSON.stringify(icons)};\n`)
mkdirSync(join(root, 'bin'), { recursive: true })
for (const arch of ['arm64', 'x86_64']) {
  execFileSync('xcrun', ['swiftc', '-swift-version', '5', '-O', '-target', `${arch}-apple-macosx12.0`,
    'native/MonitorPopup.swift', '-o', join(build, `magpie-popup-${arch}`), '-framework', 'AppKit', '-framework', 'WebKit'], { cwd: root, stdio: 'inherit' })
}
execFileSync('xcrun', ['lipo', '-create', join(build, 'magpie-popup-arm64'), join(build, 'magpie-popup-x86_64'), '-output', join(root, 'bin', 'magpie-popup')], { stdio: 'inherit' })
execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', join(root, 'bin', 'magpie-popup')], { stdio: 'inherit' })
rmSync(target, { recursive: true, force: true })
mkdirSync(target, { recursive: true })
for (const name of ['orca-plugin.json', 'README.md', 'SHARING.md', 'LICENSE', 'docs', 'src', 'bin', 'native']) {
  cpSync(join(root, name), join(target, name), { recursive: true })
}
console.log(target)
