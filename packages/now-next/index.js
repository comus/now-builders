const { createLambda } = require('@now/build-utils/lambda.js');
const download = require('@now/build-utils/fs/download.js');
const FileFsRef = require('@now/build-utils/file-fs-ref.js');
const FileBlob = require('@now/build-utils/file-blob');
const path = require('path');
const { readFile, writeFile, unlink } = require('fs.promised');
const {
  runNpmInstall,
  runPackageJsonScript,
} = require('@now/build-utils/fs/run-user-scripts.js');
const glob = require('@now/build-utils/fs/glob.js');
const {
  excludeFiles,
  validateEntrypoint,
  includeOnlyEntryDirectory,
  moveEntryDirectoryToRoot,
  excludeLockFiles,
  normalizePackageJson,
  excludeStaticDirectory,
  onlyStaticDirectory,
} = require('./utils');

/** @typedef { import('@now/build-utils/file-ref').Files } Files */
/** @typedef { import('@now/build-utils/fs/download').DownloadedFiles } DownloadedFiles */

/**
 * @typedef {Object} BuildParamsType
 * @property {Files} files - Files object
 * @property {string} entrypoint - Entrypoint specified for the builder
 * @property {string} workPath - Working directory for this build
 */

/**
 * Read package.json from files
 * @param {DownloadedFiles} files
 */
async function readPackageJson(files) {
  if (!files['package.json']) {
    return {};
  }

  const packageJsonPath = files['package.json'].fsPath;
  return JSON.parse(await readFile(packageJsonPath, 'utf8'));
}

/**
 * Write package.json
 * @param {string} workPath
 * @param {Object} packageJson
 */
async function writePackageJson(workPath, packageJson) {
  await writeFile(
    path.join(workPath, 'package.json'),
    JSON.stringify(packageJson, null, 2),
  );
}

/**
 * Write .npmrc with npm auth token
 * @param {string} workPath
 * @param {string} token
 */
async function writeNpmRc(workPath, token) {
  await writeFile(
    path.join(workPath, '.npmrc'),
    `//registry.npmjs.org/:_authToken=${token}`,
  );
}

exports.config = {
  maxLambdaSize: '5mb',
};

/**
 * @param {BuildParamsType} buildParams
 * @returns {Promise<Files>}
 */
exports.build = async ({ files, workPath, entrypoint }) => {
  // entrypoint 即係 src: package.json, next.config.js
  validateEntrypoint(entrypoint);

  console.log('downloading user files...');
  // 找到 next.config.js 所在的資料夾
  const entryDirectory = path.dirname(entrypoint);
  // 將 files 過濾，只保留在 next.config.js 所在的資料夾
  const filesOnlyEntryDirectory = includeOnlyEntryDirectory(
    files,
    entryDirectory,
  );
  // next.config.js 所在的資料夾內的檔案: 去除前面的路徑
  const filesWithEntryDirectoryRoot = moveEntryDirectoryToRoot(
    filesOnlyEntryDirectory,
    entryDirectory,
  );
  // 不要 lock files
  const filesWithoutLockfiles = excludeLockFiles(filesWithEntryDirectoryRoot);
  // 不要 static 資料夾
  const filesWithoutStaticDirectory = excludeStaticDirectory(
    filesWithoutLockfiles,
  );
  // 下載 entrypoint 內的檔案到 workPath
  const downloadedFiles = await download(filesWithoutStaticDirectory, workPath);

  console.log('normalizing package.json');
  // 搞一搞 package.json
  // dependencies: 加入 react, react-dom, next-server
  // devDependencies: 加入 next, next-server
  // scripts: 加入 'now-build': 'next build --lambdas'
  // packageJson 是一個 object
  const packageJson = normalizePackageJson(
    await readPackageJson(downloadedFiles),
  );
  console.log('normalized package.json result: ', packageJson);
  await writePackageJson(workPath, packageJson);

  if (process.env.NPM_AUTH_TOKEN) {
    console.log('found NPM_AUTH_TOKEN in environment, creating .npmrc');
    await writeNpmRc(workPath, process.env.NPM_AUTH_TOKEN);
  }

  // 在 workPath 中執行 npm install
  console.log('running npm install...');
  await runNpmInstall(workPath, ['--prefer-offline']);
  console.log('running user script...');
  // 在 workPath 中運行 now-build
  await runPackageJsonScript(workPath, 'now-build');
  console.log('running npm install --production...');
  // 運行多一次 npm install (加入 production)
  await runNpmInstall(workPath, ['--prefer-offline', '--production']);
  if (process.env.NPM_AUTH_TOKEN) {
    await unlink(path.join(workPath, '.npmrc'));
  }

  // 將所有檔案 (build 完後) 定義為 filesAfterBuild
  const filesAfterBuild = await glob('**', workPath);

  console.log('preparing lambda files...');
  let buildId;
  try {
    // 讀取 .next/BUILD_ID
    buildId = await readFile(path.join(workPath, '.next', 'BUILD_ID'), 'utf8');
  } catch (err) {
    console.error(
      'BUILD_ID not found in ".next". The "package.json" "build" script did not run "next build"',
    );
    throw new Error('Missing BUILD_ID');
  }
  // 定義 dotNextRootFiles 為 .next 裡的所有檔案
  const dotNextRootFiles = await glob('.next/*', workPath);
  // 定義 dotNextServerRootFiles 為 .next/server 裡的所有檔案
  const dotNextServerRootFiles = await glob('.next/server/*', workPath);
  // 將 workPath/node_modules 裡的所有檔案, 不要裡面的 .cache 檔案
  const nodeModules = excludeFiles(
    await glob('node_modules/**', workPath),
    file => file.startsWith('node_modules/.cache'),
  );
  // 將 @now/node-bridge 的內容放落 now__bridge.js
  const launcherFiles = {
    'now__bridge.js': new FileFsRef({ fsPath: require('@now/node-bridge') }),
  };
  // nextFiles 的檔案包括
  // node_modules
  // .next
  // .next/server
  // now__bridge
  // next.config.js (如果有)
  const nextFiles = {
    ...nodeModules,
    ...dotNextRootFiles,
    ...dotNextServerRootFiles,
    ...launcherFiles,
  };
  if (filesAfterBuild['next.config.js']) {
    nextFiles['next.config.js'] = filesAfterBuild['next.config.js'];
  }
  if (filesAfterBuild['launcher.config.js']) {
    nextFiles['launcher.config.js'] = filesAfterBuild['launcher.config.js'];
  }
  // 記錄 pages 裡的所有檔案
  // pages 的路徑為 .next/server/static/buildId/pages
  const pages = await glob(
    '**/*.js',
    path.join(workPath, '.next', 'server', 'static', buildId, 'pages'),
  );
  // 將 launcher.js 的資料攞出黎
  const launcherPath = path.join(__dirname, 'launcher.js');
  const launcherData = await readFile(launcherPath, 'utf8');

  // 一開始定義 lambdas
  const lambdas = {};
  // 同步執行
  await Promise.all(
    // 每個 pages 的檔案 loop 一 loop
    Object.keys(pages).map(async (page) => {
      // 不要 _app.js, _error.js, _document.js
      // These default pages don't have to be handled as they'd always 404
      if (['_app.js', '_error.js', '_document.js'].includes(page)) {
        return;
      }

      // 只要 page 檔案的 pathname (不要 .js)
      const pathname = page.replace(/\.js$/, '');
      // 將 pathname 放到 launcherData
      const launcher = launcherData.replace(
        'PATHNAME_PLACEHOLDER',
        `/${pathname.replace(/(^|\/)index$/, '')}`,
      );

      // pageFiles
      // .next/server/static/${buildId}/pages/_document.js
      // .next/server/static/${buildId}/pages/_app.js
      // .next/server/static/${buildId}/pages/_error.js
      // .next/server/static/${buildId}/pages/${page}
      const pageFiles = {
        [`.next/server/static/${buildId}/pages/_document.js`]: filesAfterBuild[
          `.next/server/static/${buildId}/pages/_document.js`
        ],
        [`.next/server/static/${buildId}/pages/_app.js`]: filesAfterBuild[
          `.next/server/static/${buildId}/pages/_app.js`
        ],
        [`.next/server/static/${buildId}/pages/_error.js`]: filesAfterBuild[
          `.next/server/static/${buildId}/pages/_error.js`
        ],
        [`.next/server/static/${buildId}/pages/${page}`]: filesAfterBuild[
          `.next/server/static/${buildId}/pages/${page}`
        ],
      };

      console.log(`Creating lambda for page: "${page}"...`);
      // 為每個 page 建立 lambda
      // lambdas[next.config.js 所在的資料夾/page的pathname]
      lambdas[path.join(entryDirectory, pathname)] = await createLambda({
        files: {
          // nextFiles 的檔案包括
          // node_modules
          // .next
          // .next/server
          // now__bridge
          // next.config.js (如果有)
          ...nextFiles,
          // pageFiles
          // .next/server/static/${buildId}/pages/_document.js
          // .next/server/static/${buildId}/pages/_app.js
          // .next/server/static/${buildId}/pages/_error.js
          // .next/server/static/${buildId}/pages/${page}
          ...pageFiles,
          // now__launcher.js
          'now__launcher.js': new FileBlob({ data: launcher }),
        },
        handler: 'now__launcher.launcher',
        runtime: 'nodejs8.10',
      });
      console.log(`Created lambda for page: "${page}"`);
    }),
  );

  const nextStaticFiles = await glob(
    '**',
    path.join(workPath, '.next', 'static'),
  );
  const staticFiles = Object.keys(nextStaticFiles).reduce(
    (mappedFiles, file) => ({
      ...mappedFiles,
      [path.join(entryDirectory, `_next/static/${file}`)]: nextStaticFiles[file],
    }),
    {},
  );

  const nextStaticDirectory = onlyStaticDirectory(filesWithoutLockfiles);
  const staticDirectoryFiles = Object.keys(nextStaticDirectory).reduce(
    (mappedFiles, file) => ({
      ...mappedFiles,
      [path.join(entryDirectory, file)]: nextStaticDirectory[file],
    }),
    {},
  );

  return { ...lambdas, ...staticFiles, ...staticDirectoryFiles };
};

// cachePath: a writable temporary directory where you can build a cache for the next run
exports.prepareCache = async ({
  files, entrypoint, cachePath, workPath,
}) => {
  console.log('downloading user files...');
  // 攞 entry 檔案的資料夾
  const entryDirectory = path.dirname(entrypoint);
  // files 為好多好多檔案
  // 我需要過濾返 entry 資料夾裡面的所有檔案
  const filesOnlyEntryDirectory = includeOnlyEntryDirectory(
    files,
    entryDirectory,
  );
  // 將 entry 資料夾裡面的所有檔案，進行 rename，去走前面的路徑
  const filesWithEntryDirectoryRoot = moveEntryDirectoryToRoot(
    filesOnlyEntryDirectory,
    entryDirectory,
  );
  // 去走 lock files
  const filesWithoutLockfiles = excludeLockFiles(filesWithEntryDirectoryRoot);
  // 去走 static 資料夾
  const filesWithoutStaticDirectory = excludeStaticDirectory(
    filesWithoutLockfiles,
  );
  // 開始下載上面的檔案到 workPath
  await download(filesWithoutStaticDirectory, workPath);
  // 將已下載到 workPath 的 .next 檔案複制到 cachePath
  await download(await glob('.next/**', workPath), cachePath);
  // 將已下載到 workPath 的 node_modules 檔案複制到 cachePath
  await download(await glob('node_modules/**', workPath), cachePath);

  // 印野
  console.log('.next folder contents', await glob('.next/**', cachePath));
  console.log(
    '.cache folder contents',
    await glob('node_modules/.cache/**', cachePath),
  );

  // cachePath 而家有兩樣野: .next 和 node_modules
  // 但唔知點解要在 cachePath 裡面 npm install
  console.log('running npm install...');
  await runNpmInstall(cachePath);

  // 輸出四種檔案
  // 1. cachePath/.next/records.json
  // 2. cachePath/.next/server/records.json
  // 3. cachePath/node_modules/**
  // 4. cachePath/yarn.lock
  return {
    ...(await glob('.next/records.json', cachePath)),
    ...(await glob('.next/server/records.json', cachePath)),
    ...(await glob('node_modules/**', cachePath)),
    ...(await glob('yarn.lock', cachePath)),
  };

  // 當有新 build 時
  // 1. workPath 填充住上次 build 的 prepareCache 結果
  // 2. 將 workPath 交比 analyze
  // 3. analyze 可以讀寫 workPath
};
