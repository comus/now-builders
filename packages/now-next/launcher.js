const { Server } = require('http');
const next = require('next-server');
const url = require('url');
const express = require('express');
const { Bridge } = require('./now__bridge.js');

const bridge = new Bridge();
bridge.port = 3000;

process.env.NODE_ENV = 'production';

let app = next({});

let server = express();

let config;
try {
  config = require('./launcher.config.js');
} catch (err) {
  console.log('Error load launcher.config.js', err);
}

try {
  if (config && config.app) {
    app = config.app(app);
  }
} catch (err) {
  console.error('Error config app', err);
}

try {
  if (config && config.server) {
    server = config.server(server);
  }
} catch (err) {
  console.error('Error config server', err);
}

server.use((req, res) => {
  const parsedUrl = url.parse(req.url, true);
  app.render(req, res, 'PATHNAME_PLACEHOLDER', parsedUrl.query, parsedUrl);
});

const httpServer = new Server(server);
httpServer.listen(bridge.port);

exports.launcher = bridge.launcher;
