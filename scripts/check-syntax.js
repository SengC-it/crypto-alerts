// Dependency-free JavaScript syntax check used by local and CI verification.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoots = ['api', 'scripts', 'src', 'tests'];

function collectJavaScript(directory) {
  if (!fs.existsSync(directory)) return [];
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...collectJavaScript(fullPath));
    else if (entry.isFile() && fullPath.endsWith('.js')) files.push(fullPath);
  }
  return files;
}

const files = [
  ...sourceRoots.flatMap(directory => collectJavaScript(path.join(root, directory))),
  path.join(root, 'test-server.js'),
];
let failed = false;

for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.status !== 0) failed = true;
}

if (failed) process.exitCode = 1;
else console.log('JavaScript syntax check passed:', files.length, 'files');
