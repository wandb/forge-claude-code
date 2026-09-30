// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: forge-claude-code

// `registerPlugin` with InstallSource.Local must register the marketplace from
// the npm-installed package on disk (no git clone), so CI/sandbox environments
// without SSH access to GitHub can still install. The packed marketplace must
// also source the plugin from that tree, or `claude plugin install` still
// clones GitHub (#176).

import { test, suite, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { MARKETPLACE_NAME, MARKETPLACE_REPO } from '../src/setup.ts';
import { readFakeCalls } from './helpers.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const FAKE_CLAUDE_BIN_DIR = path.join(HERE, 'fixtures', 'fake-claude-bin');

function seedLocalPluginTree(npmPrefix: string): string {
  const pkgDir = path.join(npmPrefix, 'lib', 'node_modules', '@coreweave', 'forge-claude-code');
  fs.mkdirSync(path.join(pkgDir, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(
    path.join(pkgDir, '.claude-plugin', 'marketplace.json'),
    JSON.stringify({ name: MARKETPLACE_NAME, plugins: [] }),
  );
  return pkgDir;
}

let tmpHome: string;
let tmpNpmPrefix: string;
let savedHome: string | undefined;
let savedPath: string | undefined;
let savedMktName: string | undefined;
let savedNpmPrefix: string | undefined;

beforeEach(() => {
  fs.chmodSync(path.join(FAKE_CLAUDE_BIN_DIR, 'claude'), 0o755);
  tmpHome = fs.mkdtempSync('/tmp/wcp-install-source-test-');
  tmpNpmPrefix = fs.mkdtempSync('/tmp/wcp-install-source-npm-');
  savedHome = process.env.HOME;
  savedPath = process.env.PATH;
  savedMktName = process.env.FAKE_CLAUDE_MARKETPLACE_NAME;
  savedNpmPrefix = process.env.npm_config_prefix;
  process.env.HOME = tmpHome;
  process.env.PATH = `${FAKE_CLAUDE_BIN_DIR}:${process.env.PATH}`;
  process.env.FAKE_CLAUDE_MARKETPLACE_NAME = MARKETPLACE_NAME;
  process.env.npm_config_prefix = tmpNpmPrefix;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedPath === undefined) delete process.env.PATH;
  else process.env.PATH = savedPath;
  if (savedMktName === undefined) delete process.env.FAKE_CLAUDE_MARKETPLACE_NAME;
  else process.env.FAKE_CLAUDE_MARKETPLACE_NAME = savedMktName;
  if (savedNpmPrefix === undefined) delete process.env.npm_config_prefix;
  else process.env.npm_config_prefix = savedNpmPrefix;
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(tmpNpmPrefix, { recursive: true, force: true });
});

suite('install --source=local', () => {
  test('findLocalPluginPath: returns the seeded tree, null otherwise', async () => {
    // Incremental setup: start with no install, then a half-install, then a
    // full install. Each step asserts that findLocalPluginPath reflects the
    // current on-disk state.
    const { findLocalPluginPath } = await import('../src/setup.ts');

    assert.equal(findLocalPluginPath(), null, 'no install: expected null');

    const dir = path.join(tmpNpmPrefix, 'lib', 'node_modules', '@coreweave', 'forge-claude-code');
    fs.mkdirSync(dir, { recursive: true });
    assert.equal(findLocalPluginPath(), null, 'dir without marketplace.json: expected null');

    fs.mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({ name: MARKETPLACE_NAME, plugins: [] }),
    );
    assert.equal(findLocalPluginPath(), dir, 'seeded: expected the seeded path');
  });

  test('registerPlugin(Local): registers from the local path, installs the plugin, skips drift-update', async () => {
    // Local source bypasses github cloning entirely: marketplace is registered
    // from the npm-installed directory, plugin installs as normal, and the
    // drift-detection update never fires (npm is the version-of-record, so the
    // marketplace "ref" is a directory path with no meaningful comparison).
    const { registerPlugin, InstallSource } = await import('../src/setup.ts');
    const pkgDir = seedLocalPluginTree(tmpNpmPrefix);

    const result = registerPlugin(path.join(tmpHome, 'log.txt'), InstallSource.Local);

    const calls = readFakeCalls(tmpHome);
    const addCall = calls.find((c) => c.startsWith('plugin marketplace add'));
    assert.ok(addCall, 'expected plugin marketplace add to be called');
    assert.ok(addCall.includes(pkgDir), `expected local path ${pkgDir} in: ${addCall}`);
    assert.ok(!addCall.includes(`${MARKETPLACE_REPO}#`), `expected no github source in: ${addCall}`);
    assert.ok(calls.some((c) => c.startsWith('plugin install')));
    assert.ok(!calls.some((c) => c.startsWith('plugin update')));
    assert.equal(result.pluginUpdated, false);
  });

  test('registerPlugin(Local): throws with a helpful error when no local plugin tree is found', async () => {
    const { registerPlugin, InstallSource } = await import('../src/setup.ts');

    assert.throws(
      () => registerPlugin(path.join(tmpHome, 'log.txt'), InstallSource.Local),
      /npm install -g @coreweave\/forge-claude-code/,
    );
  });

  test('npm pack: the tarball sources the plugin from itself while the repo copy keeps its GitHub pin', () => {
    const pkgDir = path.join(tmpHome, 'pkg');
    for (const entry of ['package.json', '.claude-plugin', 'hooks', 'skills', 'scripts']) {
      fs.cpSync(path.join(REPO_ROOT, entry), path.join(pkgDir, entry), { recursive: true });
    }
    const manifestPath = path.join(pkgDir, '.claude-plugin', 'marketplace.json');
    // Exercise the original regression even when the checked-in source is already local.
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.plugins[0].source = { source: 'github', repo: MARKETPLACE_REPO, ref: 'v0.2.15', sha: 'abc123' };
    const repoManifest = `${JSON.stringify(manifest, null, 2)}\n`;
    fs.writeFileSync(manifestPath, repoManifest);

    const pack = spawnSync('npm', ['pack', '--pack-destination', pkgDir], { cwd: pkgDir, encoding: 'utf8' });
    assert.equal(pack.status, 0, pack.stderr);
    const tarball = fs.readdirSync(pkgDir).find((f) => f.endsWith('.tgz'));
    assert.ok(tarball, `expected a tarball in ${pkgDir}`);
    const unpacked = path.join(tmpHome, 'unpacked');
    fs.mkdirSync(unpacked);
    const untar = spawnSync('tar', ['-xzf', path.join(pkgDir, tarball), '-C', unpacked], { encoding: 'utf8' });
    assert.equal(untar.status, 0, untar.stderr);

    const packedRoot = path.join(unpacked, 'package');
    const expected = JSON.parse(repoManifest);
    expected.plugins[0].source = './';
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(packedRoot, '.claude-plugin', 'marketplace.json'), 'utf8')),
      expected,
    );
    for (const file of ['.claude-plugin/plugin.json', 'hooks/hooks.json', 'hooks/hook-handler.sh']) {
      assert.ok(fs.existsSync(path.join(packedRoot, file)), `'./' must resolve to a plugin root containing ${file}`);
    }
    assert.equal(fs.readFileSync(manifestPath, 'utf8'), repoManifest, 'packing must restore the repo manifest');
  });

  test('npm pack: a pack that died before postpack still restores the repo manifest on the next pack', () => {
    const pkgDir = path.join(tmpHome, 'pkg');
    fs.cpSync(path.join(REPO_ROOT, '.claude-plugin'), path.join(pkgDir, '.claude-plugin'), { recursive: true });
    fs.cpSync(path.join(REPO_ROOT, 'scripts'), path.join(pkgDir, 'scripts'), { recursive: true });
    const manifestPath = path.join(pkgDir, '.claude-plugin', 'marketplace.json');
    // Exercise the original regression even when the checked-in source is already local.
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.plugins[0].source = { source: 'github', repo: MARKETPLACE_REPO, ref: 'v0.2.15', sha: 'abc123' };
    const repoManifest = `${JSON.stringify(manifest, null, 2)}\n`;
    fs.writeFileSync(manifestPath, repoManifest);
    const script = path.join(pkgDir, 'scripts', 'build', 'pack-marketplace.mjs');

    // prepack, crash, then a full prepack/postpack cycle.
    for (const args of [[], [], ['--restore']]) {
      const run = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
      assert.equal(run.status, 0, run.stderr);
    }

    assert.equal(fs.readFileSync(manifestPath, 'utf8'), repoManifest);
  });

  test('registerPlugin(): default source falls back to the github marketplace ref', async () => {
    const { registerPlugin, MARKETPLACE_SOURCE } = await import('../src/setup.ts');

    registerPlugin(path.join(tmpHome, 'log.txt'));

    const calls = readFakeCalls(tmpHome);
    const addCall = calls.find((c) => c.startsWith('plugin marketplace add'));
    assert.ok(addCall);
    assert.ok(addCall.includes(MARKETPLACE_SOURCE), `expected github source ${MARKETPLACE_SOURCE}, got: ${addCall}`);
  });
});
