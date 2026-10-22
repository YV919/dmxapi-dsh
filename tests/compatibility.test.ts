import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

const manifest = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as {
  version: string
  engines: { dsh: string }
  peerDependencies: Record<string, string>
}

test('package metadata admits the current Harness 0.2.1-rc.2 runtime', () => {
  assert.equal(manifest.version, '0.2.2')
  assert.ok(manifest.engines.dsh.includes('0.2.1-rc.2'))
  for (const [name, range] of Object.entries(manifest.peerDependencies)) {
    assert.ok(range.includes('0.2.1-rc.2'), `${name} must admit 0.2.1-rc.2`)
  }
})
