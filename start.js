// Starts the server for browser use, closing a leftover copy of this app if there is one.
// Run with: npm start
const { spawn } = require('child_process');
const { classifyPort, killPort, portOwnerName } = require('./electron/portCheck');

const PORT = 3000;

(async () => {
  const state = await classifyPort(PORT);

  if (state === 'other') {
    console.error(`Port ${PORT} is being used by ${portOwnerName(PORT) || 'another program'}. Close it and try again.`);
    process.exit(1);
  }

  if (state === 'ours') {
    killPort(PORT);
    console.log(`Closed the previous copy of Time Tracker Pro on port ${PORT}.`);
    await new Promise(resolve => setTimeout(resolve, 300));
  }

  spawn('node', ['server.js'], { stdio: 'inherit' });
})();
