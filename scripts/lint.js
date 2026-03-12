import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const allowedExtensions = new Set(['.js', '.mjs']);
const ignored = new Set(['.git', '.omx', 'node_modules']);

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (ignored.has(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walk(fullPath));
    } else if (allowedExtensions.has(path.extname(entry.name))) {
      files.push(fullPath);
    }
  }
  return files;
}

const files = await walk(repoRoot);
const failures = [];

for (const file of files) {
  const source = await readFile(file, 'utf8');
  if (source.includes('\t')) failures.push(`${file}: contains tabs`);
  if (source.split(/\r?\n/).some((line) => /\s+$/.test(line))) failures.push(`${file}: has trailing whitespace`);
}

if (failures.length) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`Lint PASS (${files.length} files checked)`);
}
