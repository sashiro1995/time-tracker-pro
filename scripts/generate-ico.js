const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root     = path.join(__dirname, '..');
const input    = path.join(root, 'public', 'icons', 'icon.png');
const tempOut  = path.join(root, 'public', 'icons', 'icons', 'win', 'icon.ico');
const finalOut = path.join(root, 'public', 'icons', 'icon.ico');

execSync(`npx electron-icon-builder --input="${input}" --output="${path.join(root, 'public', 'icons')}"`, { stdio: 'inherit' });
fs.copyFileSync(tempOut, finalOut);
console.log('icon.ico ready at', finalOut);
