import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

const windows = process.platform === 'win32'
const packageName = 'dsh-dmxapi-0.2.0.tgz'
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dmx installer 空格 '))
  const source = join(root, '下载 插件')
  const desktop = join(root, '官方 Desktop')
  const home = join(root, 'Harness 数据')
  const profile = join(home, 'profiles', 'desktop')
  const commandDir = join(desktop, 'resources', 'runtime', 'cli', 'bin')
  const output = join(root, 'args.txt')
  const npmOutput = join(root, 'npm.txt')
  const bin = join(root, 'mock-bin')
  mkdirSync(join(source, 'artifacts'), { recursive: true })
  mkdirSync(commandDir, { recursive: true })
  mkdirSync(bin, { recursive: true })
  copyFileSync(resolve('install.ps1'), join(source, 'install.ps1'))
  writeFileSync(join(source, 'artifacts', packageName), 'test package; not executable')
  writeFileSync(join(desktop, 'DeepSeek Harness.exe'), '')
  writeFileSync(join(desktop, 'resources', 'app.asar'), '')
  writeFileSync(join(commandDir, 'dsh.cmd'), '@echo off\r\necho %*> "%DMX_INSTALL_TEST_OUTPUT%"\r\nexit /b %DMX_INSTALL_TEST_EXIT%\r\n')
  writeFileSync(join(bin, 'npx.cmd'), '@echo off\r\necho %*> "%DMX_INSTALL_TEST_NPM%"\r\nexit /b 0\r\n')

  function initialize() {
    mkdirSync(profile, { recursive: true })
    writeFileSync(join(profile, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } }))
  }
  function run(options: { args?: string; running?: boolean; exit?: number } = {}) {
    // Mock process/registry discovery. All path validation, copying, argument forwarding,
    // failure handling, and child .cmd execution run in a real Windows PowerShell.
    const command = `
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
function Get-Process {
  param([string]$Name, $ErrorAction)
  if ($Name -and $env:DMX_INSTALL_TEST_RUNNING -eq '1') { [pscustomobject]@{Id=12345} }
}
function Get-ItemProperty {
  param($Path, $ErrorAction)
  [pscustomobject]@{DisplayName='DeepSeek Harness 0.2.0-rc.2';InstallLocation=$env:DMX_INSTALL_TEST_DESKTOP}
}
try { & ${quote(join(source, 'install.ps1'))} ${options.args ?? `-DesktopPath ${quote(desktop)}`}; exit 0 } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }
`
    return spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], {
      encoding: 'utf8', timeout: 15000,
      env: { ...process.env, DSH_HOME: home, PATH: `${bin};${process.env.PATH}`, DMX_INSTALL_TEST_DESKTOP: desktop, DMX_INSTALL_TEST_OUTPUT: output, DMX_INSTALL_TEST_NPM: npmOutput, DMX_INSTALL_TEST_EXIT: String(options.exit ?? 0), DMX_INSTALL_TEST_RUNNING: options.running ? '1' : '0' },
    })
  }
  return { root, source, desktop, home, profile, output, npmOutput, initialize, run, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

test('desktop installer uses bundled CLI and preserves package across Chinese/space paths', { skip: !windows }, () => {
  const f = fixture()
  try {
    f.initialize()
    const originalManifest = readFileSync(join(f.profile, 'package.json'), 'utf8')
    const result = f.run({ args: '' })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(readFileSync(f.output, 'utf8').trim(), `plugin --profile desktop add file:local-packages/${packageName}`)
    assert.equal(readFileSync(join(f.profile, 'local-packages', packageName), 'utf8'), 'test package; not executable')
    assert.equal(readFileSync(join(f.profile, 'package.json'), 'utf8'), originalManifest)
    assert.equal(existsSync(f.npmOutput), false)
  } finally { f.cleanup() }
})

test('desktop installer refuses missing runtime or uninitialized profile without npm fallback or writes', { skip: !windows }, () => {
  const f = fixture()
  try {
    let result = f.run({ args: `-DesktopPath ${quote(join(f.root, 'missing'))}` })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /找不到 DeepSeek Harness 桌面端内置命令/)
    assert.equal(existsSync(f.profile), false)
    result = f.run()
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /桌面 profile 尚未初始化/)
    assert.equal(existsSync(f.profile), false)
    assert.equal(existsSync(f.output), false)
    assert.equal(existsSync(f.npmOutput), false)
  } finally { f.cleanup() }
})

test('desktop installer leaves active desktop and profile locks untouched', { skip: !windows }, () => {
  const f = fixture()
  try {
    f.initialize()
    const running = f.run({ running: true })
    assert.notEqual(running.status, 0)
    assert.match(running.stderr, /桌面端仍在运行/)
    for (const lockName of ['package.json.lock', 'lock']) {
      const lockPath = join(f.profile, lockName)
      writeFileSync(lockPath, '12345\n')
      const locked = f.run()
      assert.notEqual(locked.status, 0)
      assert.ok(locked.stderr.includes(`profile 锁文件（${lockName}）`), locked.stderr)
      assert.equal(readFileSync(lockPath, 'utf8'), '12345\n')
      rmSync(lockPath)
    }
    assert.equal(existsSync(join(f.profile, 'local-packages')), false)
    assert.equal(existsSync(f.output), false)
    assert.equal(existsSync(f.npmOutput), false)
  } finally { f.cleanup() }
})

test('desktop installer reports native command failure', { skip: !windows }, () => {
  const f = fixture()
  try {
    f.initialize()
    const result = f.run({ exit: 7 })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /退出码：7/)
    assert.equal(existsSync(f.output), true)
    assert.equal(existsSync(f.npmOutput), false)
  } finally { f.cleanup() }
})

test('only explicit web mode invokes the pinned npm Harness CLI', { skip: !windows }, () => {
  const f = fixture()
  try {
    const result = f.run({ args: '-Profile web' })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(readFileSync(f.npmOutput, 'utf8').trim(), `--yes @deepseek-ai/dsh@0.2.0-rc.2 plugin --profile web add file:local-packages/${packageName}`)
    assert.equal(existsSync(f.profile), false)
    assert.equal(existsSync(join(f.home, 'profiles', 'web', 'local-packages', packageName)), true)
    assert.equal(existsSync(f.output), false)
  } finally { f.cleanup() }
})
