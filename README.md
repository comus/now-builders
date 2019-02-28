# 🛠️ now-builders

> 更新到
>
> https://github.com/zeit/now-builders/tree/1cd362126cee7e09dbf2e8f716db48c004e93760

跟官方有不一樣的地方

- **now-node**: now.json 中的 build config 可以指定 srcDir 和 distDir，這樣當 now-build 時可以將 src 的東西編譯到 dist，NOW 會知道最後要用的是編譯後的 dist 而不是 src。
- **now-next**: 支援 now.launcher.js


## How to use

**now-node**

now.json

```
{
  "version": 2,
  "builds": [{ "src": "index.js", "use": "now-node" }]
}
```

**now-next**

now.json

```
{
  "version": 2,
  "name": "nextjs",
  "builds": [
    { "src": "package.json", "use": "now-next" }
  ]
}
```

now.launcher.js

```js
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
```


## Publish now-node


```
cd packages/now-node-bridge
yarn build
cd ../now-node
yarn build
npm publish
```


## Publish now-next


```
npm publish
```

