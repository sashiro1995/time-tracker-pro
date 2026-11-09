// Verify the local Windows build without installing or publishing it.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const asar = require('@electron/asar');

const root = path.resolve(__dirname, '..');
const { version } = require('../package.json');
const dist = path.join(root, 'dist');
const archive = path.join(dist, 'win-unpacked', 'resources', 'app.asar');
const exeName = `Time-Tracker-Pro-Setup-${version}.exe`;
const exe = fs.readFileSync(path.join(dist, exeName));
const manifest = fs.readFileSync(path.join(dist, 'latest.yml'), 'utf8');
const sha512 = crypto.createHash('sha512').update(exe).digest('base64');
const sha256 = crypto.createHash('sha256').update(exe).digest('hex');
assert.equal(exe.subarray(0, 2).toString(), 'MZ');
assert.equal(exe.subarray(exe.readUInt32LE(0x3c), exe.readUInt32LE(0x3c) + 4).toString(), 'PE\0\0');
assert.ok(manifest.includes(`version: ${version}\n`) || manifest.includes(`version: ${version}\r\n`));
assert.ok(manifest.includes(`url: ${exeName}`));
assert.ok(manifest.includes(`path: ${exeName}`));
assert.ok(manifest.includes(`size: ${exe.length}`));
const hashes = [...manifest.matchAll(/sha512: (\S+)/g)].map(match => match[1]);
assert.equal(hashes.length, 2);
assert.ok(hashes.every(hash => hash === sha512));
assert.ok(fs.statSync(path.join(dist, exeName + '.blockmap')).size > 0);

const packagedFiles = asar.listPackage(archive).map(file => file.replaceAll('\\', '/'));
assert.ok(!packagedFiles.some(file => /^\/(data|sessions|plans|video_notes|scripts|\.tmp|\.claude)(\/|$)/.test(file)));
assert.deepEqual(JSON.parse(asar.extractFile(archive, 'defaults/trackers.json').toString()), { trackers: [] });
assert.equal(JSON.parse(asar.extractFile(archive, 'package.json').toString()).version, version);

// Compare every shipped first-party runtime/default file with the checked source.
const expected = ['server.js', 'start.js'];
function collect(relative) {
  for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
    const child = relative + '/' + entry.name;
    if (entry.isDirectory()) collect(child);
    else expected.push(child);
  }
}
for (const dir of ['electron', 'defaults', 'public/js', 'public/css', 'stream-dock-plugin']) collect(dir);
expected.push('public/index.html');
for (const file of expected) {
  assert.ok(packagedFiles.includes('/' + file), `Missing ${file}`);
  assert.ok(fs.readFileSync(path.join(root, file)).equals(asar.extractFile(archive, path.normalize(file))), `Stale ${file}`);
}
const report = { version, installer: exeName, size: exe.length, sha256, sha512,
  runtimeFilesMatched: expected.length, privateFoldersExcluded: true, cleanTrackerDefaults: true };
fs.writeFileSync(path.join(dist, `verification-${version}.json`), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
