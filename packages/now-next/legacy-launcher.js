const { Server } = require('http');
const next = require('next-server');
const url = require('url');
const { Bridge } = require('./now__bridge.js');

const bridge = new Bridge();
bridge.port = 3000;

process.env.NODE_ENV = 'production';

const app = next({});

const pathname = 'PATHNAME_PLACEHOLDER';

const handle = (req, res) => {
  const parsedUrl = url.parse(req.url, true);
  app.render(req, res, pathname, parsedUrl.query, parsedUrl);
};

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
    app,
    pathname,
    handle,
  });
} else {
  const server = new Server(handle);
  server.listen(bridge.port);
}

exports.launcher = bridge.launcher;
