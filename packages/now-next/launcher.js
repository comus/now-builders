process.env.NODE_ENV = 'production';

const { Server } = require('http');
const { Bridge } = require('./now__bridge.js');
const page = require('./page.js');

const bridge = new Bridge();
bridge.port = 3000;

let customLauncher;
try {
  customLauncher = require('./now.launcher.js');
} catch (err) {
  console.log('Error load custom launcher', err);
}

if (customLauncher) {
  const launcher = customLauncher.launcher || customLauncher;
  launcher({
    port: bridge.port,
    handle: page.render,
  });
} else {
  const server = new Server(page.render);
  server.listen(bridge.port);
}

exports.launcher = bridge.launcher;
