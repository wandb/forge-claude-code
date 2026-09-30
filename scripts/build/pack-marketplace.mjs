#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: forge-claude-code

// `--source=local` installs from the packed tree, so its plugin must not point at GitHub (#176).
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import process from 'node:process';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const manifestPath = path.join(repoRoot, '.claude-plugin', 'marketplace.json');
const cacheDir = path.join(repoRoot, 'node_modules', '.cache', 'forge-claude-code');
const backupPath = path.join(cacheDir, 'marketplace.json');

if (process.argv[2] === '--restore') {
  fs.copyFileSync(backupPath, manifestPath);
  fs.rmSync(backupPath);
} else {
  // A pack that died before postpack left the manifest rewritten, so keep its backup.
  if (!fs.existsSync(backupPath)) {
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.copyFileSync(manifestPath, backupPath);
  }
  const data = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  data.plugins[0].source = './';
  fs.writeFileSync(manifestPath, `${JSON.stringify(data, null, 2)}\n`);
}
