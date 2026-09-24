import { build } from 'esbuild'
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises'

await mkdir('lib', { recursive: true })
await mkdir('artifacts', { recursive: true })
await build({ entryPoints: ['src/index.ts'], outfile: 'lib/index.js', platform: 'node', format: 'esm', target: 'node22', bundle: true })
const result = await build({
  entryPoints: ['src/client/index.ts'], bundle: true, platform: 'browser', format: 'cjs',
  target: 'es2022', write: false, jsx: 'automatic',
  external: ['react', 'react/jsx-runtime', 'react-dom'],
  loader: { '.css': 'text', '.png': 'dataurl' },
})
const pkg = JSON.parse(await readFile('package.json', 'utf8'))
const body = result.outputFiles[0].text
await writeFile('lib/client.js', `window.__ModuleLoader__.load({\n  id: ${JSON.stringify(pkg.name)},\n  factory: (require) => {\n    var module = { exports: {} };\n    var exports = module.exports;\n${body}\n    return module.exports;\n  }\n});\n`)
await copyFile('node_modules/js-yaml/LICENSE', 'lib/LICENSE.js-yaml')
console.log(`Built ${pkg.name}@${pkg.version}: host ESM + Harness client factory`)
