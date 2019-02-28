process.env.NODE_ENV = 'production';

const { Server } = require('http');
const { Bridge } = require('./now__bridge.js');
const page = require('./page.js');

let customLauncher;
try {
  customLauncher = require('./now.launcher.js');
} catch (err) {
  console.log('Error load custom launcher', err);
}

let handle = page.render;

if (customLauncher) {
  const launcher = customLauncher.launcher || customLauncher;
  handle = launcher({
    handle,
  });
}

const server = new Server(handle);
const bridge = new Bridge(server);
bridge.listen();

exports.launcher = bridge.launcher;
