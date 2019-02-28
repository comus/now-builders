const { Server } = require('http');
const next = require('next-server');
const url = require('url');
const { Bridge } = require('./now__bridge.js');

process.env.NODE_ENV = 'production';

const app = next({});

const pathname = 'PATHNAME_PLACEHOLDER';

let handle = (req, res) => {
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
  handle = launcher({
    app,
    pathname,
    handle,
  });
}

const server = new Server(handle);
const bridge = new Bridge(server);
bridge.listen();

exports.launcher = bridge.launcher;
