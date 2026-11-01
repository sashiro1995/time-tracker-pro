/**
 * Time Tracker Pro — Stream Dock Plugin Setup
 *
 * Run once:  node setup.js
 *
 * What it does:
 *   1. Generates placeholder PNG icons in the plugin's images/ folder
 *   2. Copies the plugin to Stream Dock's plugins directory
 *   3. Prints next steps
 */

const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');
const os   = require('os');

// ── Paths ─────────────────────────────────────────────────────────────────────

const PLUGIN_SRC  = path.join(__dirname, 'com.timetracker.pro.sdPlugin');
const PLUGIN_NAME = 'com.timetracker.pro.sdPlugin';

// Stream Dock stores plugins here on Windows
const PLUGIN_DST  = path.join(
  os.homedir(),
  'AppData', 'Roaming', 'HotSpot', 'StreamDock', 'plugins',
  PLUGIN_NAME
);

// ── PNG generator (no external dependencies) ─────────────────────────────────

function crc32(buf) {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xFF];
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type, data) {
  const lenBuf  = Buffer.allocUnsafe(4);
  lenBuf.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf  = Buffer.allocUnsafe(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function solidPNG(width, height, r, g, b, a = 255) {
  // Build raw scanlines: each row starts with filter byte 0x00 (None)
  const rowBytes = 1 + width * 4;          // RGBA
  const raw      = Buffer.alloc(height * rowBytes);
  for (let y = 0; y < height; y++) {
    const base = y * rowBytes;
    raw[base] = 0;                          // filter: None
    for (let x = 0; x < width; x++) {
      const off  = base + 1 + x * 4;
      raw[off]   = r;
      raw[off+1] = g;
      raw[off+2] = b;
      raw[off+3] = a;
    }
  }

  const ihdr = Buffer.allocUnsafe(13);
  ihdr.writeUInt32BE(width,  0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8]  = 8;   // bit depth
  ihdr[9]  = 6;   // color type: RGBA
  ihdr[10] = 0;   // compression
  ihdr[11] = 0;   // filter
  ihdr[12] = 0;   // interlace

  const idat = zlib.deflateSync(raw);

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),   // PNG signature
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const dstPath = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, dstPath);
    } else {
      fs.copyFileSync(srcPath, dstPath);
    }
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

console.log('\nTime Tracker Pro — Stream Dock Plugin Setup\n');

// 1. Generate icons
const imagesDir = path.join(PLUGIN_SRC, 'images');
fs.mkdirSync(imagesDir, { recursive: true });

const icons = [
  { file: 'plugin-icon.png',    r: 230, g: 57,  b: 80  },   // crimson  (#E63950)
  { file: 'timer-icon.png',     r: 245, g: 158, b: 11  },   // amber    (#F59E0B)
  { file: 'stopwatch-icon.png', r: 123, g: 79,  b: 202 },   // purple   (#7B4FCA)
  { file: 'pomodoro-icon.png',  r: 220, g: 38,  b: 38  },   // tomato   (#DC2626)
];

icons.forEach(({ file, r, g, b }) => {
  const outPath = path.join(imagesDir, file);
  fs.writeFileSync(outPath, solidPNG(72, 72, r, g, b));
  console.log(`  ✓ Generated ${file}`);
});

// 2. Copy plugin to Stream Dock plugins folder
console.log(`\n  Copying plugin to:\n  ${PLUGIN_DST}\n`);
try {
  copyDir(PLUGIN_SRC, PLUGIN_DST);
  console.log('  ✓ Plugin installed\n');
} catch (err) {
  console.error(`  ✗ Copy failed: ${err.message}`);
  console.log('\n  If Stream Dock is running, close it first then re-run setup.js\n');
  process.exit(1);
}

// 3. Next steps
console.log('─'.repeat(50));
console.log('\nDone! Next steps:\n');
console.log('  1. Restart Stream Dock (close + reopen)');
console.log('  2. Start Time Tracker Pro  (npm run app)');
console.log('  3. In Stream Dock, find "Time Tracker Pro" in the action list');
console.log('  4. Drag "Timer" onto a button → click it → pick a category');
console.log('  5. Drag "Stopwatch" onto another button → pick a category');
console.log('\n  Button behaviour:');
console.log('    • Single press  → start / pause / resume');
console.log('    • Double press  → stop + log session');
console.log('    • While running → button shows live countdown / elapsed time');
console.log('\n  To update the plugin after any code changes:');
console.log('    node stream-dock-plugin/setup.js\n');
