const express = require('express');

module.exports = ({ handle }) => {
  const app = express();

  app.use((req, res, next) => {
    console.log(req.url);
    next();
  });

  app.use((req, res) => {
    handle(req, res);
  });

  return app;
};
