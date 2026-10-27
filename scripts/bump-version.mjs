// Raises the patch version before every build (npm "prebuild"):
// package.json, package-lock.json and proxy/package.json get the same version.
// Skipped in CI and Docker builds (CI or NO_VERSION_BUMP set), which build a
// version that was already committed.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

if (process.env.CI || process.env.NO_VERSION_BUMP) {
  console.log('version bump skipped (CI / NO_VERSION_BUMP)');
  process.exit(0);
}

const read = (p) => JSON.parse(readFileSync(p, 'utf8'));
const write = (p, o) => writeFileSync(p, JSON.stringify(o, null, 2) + '\n');

const pkg = read('package.json');
const m = /^(\d+)\.(\d+)\.(\d+)(.*)$/.exec(pkg.version);
if (!m) throw new Error(`package.json version is not x.y.z: ${pkg.version}`);
const next = `${m[1]}.${m[2]}.${Number(m[3]) + 1}`;

pkg.version = next;
write('package.json', pkg);

if (existsSync('package-lock.json')) {
  const lock = read('package-lock.json');
  lock.version = next;
  if (lock.packages?.['']) lock.packages[''].version = next;
  write('package-lock.json', lock);
}

if (existsSync('proxy/package.json')) {
  const gw = read('proxy/package.json');
  gw.version = next;
  write('proxy/package.json', gw);
  if (existsSync('proxy/package-lock.json')) {
    const lock = read('proxy/package-lock.json');
    lock.version = next;
    if (lock.packages?.['']) lock.packages[''].version = next;
    write('proxy/package-lock.json', lock);
  }
}

console.log(`version ${m[0]} -> ${next}`);
