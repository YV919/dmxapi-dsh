import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import semver from 'semver'
import test from 'node:test'

const packagePath = resolve('package.json')
const manifest = JSON.parse(readFileSync(packagePath, 'utf8')) as {
  version: string
  engines: { dsh: string }
  peerDependencies: Record<string, string>
}
const lockfile = JSON.parse(readFileSync(resolve('package-lock.json'), 'utf8')) as {
  packages: {
    '': {
      version: string
      engines: { dsh: string }
      peerDependencies: Record<string, string>
    }
  }
}

const compatibilityRange = '>=0.2.0-rc.2 <0.3.0-0'
const compatibleRuntimes = [
  '0.2.0-rc.2',
  '0.2.1-alpha.1',
  '0.2.1-alpha.2',
  '0.2.1-rc.2',
  '0.2.1-rc.3',
  '0.2.1',
]
const incompatibleRuntimes = ['0.2.0-rc.1', '0.3.0-rc.1', '0.3.0']

test('package metadata uses one durable Harness compatibility range', () => {
  assert.equal(manifest.version, '0.2.3')
  assert.equal(manifest.engines.dsh, compatibilityRange)
  const dshPeers = Object.entries(manifest.peerDependencies).filter(([name]) =>
    name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-'),
  )
  assert.equal(dshPeers.length, 5)
  for (const [name, range] of dshPeers) {
    assert.equal(range, compatibilityRange, `${name} must use the shared DSH range`)
  }
})

test('package-lock and installer stay aligned with the published manifest', () => {
  assert.equal(lockfile.packages[''].version, manifest.version)
  assert.deepEqual(lockfile.packages[''].engines, manifest.engines)
  assert.deepEqual(lockfile.packages[''].peerDependencies, manifest.peerDependencies)
  const installer = readFileSync(resolve('install.ps1'), 'utf8')
  assert.match(installer, new RegExp(`\\$dmxVersion = '${manifest.version.replaceAll('.', '\\.')}'`))
  assert.match(installer, /@deepseek-ai\/dsh@next/)
})

test('compatibility range admits supported prereleases and rejects the next minor line', () => {
  for (const version of compatibleRuntimes) {
    assert.equal(
      semver.satisfies(version, compatibilityRange, { includePrerelease: true }),
      true,
      `${version} should be admitted`,
    )
  }
  for (const version of incompatibleRuntimes) {
    assert.equal(
      semver.satisfies(version, compatibilityRange, { includePrerelease: true }),
      false,
      `${version} should be rejected`,
    )
  }
})
