const { createLambda } = require('@now/build-utils/lambda.js');
const download = require('@now/build-utils/fs/download.js');
const FileBlob = require('@now/build-utils/file-blob.js');
const FileFsRef = require('@now/build-utils/file-fs-ref.js');
const fs = require('fs-extra');
const glob = require('@now/build-utils/fs/glob.js');
const path = require('path');
const {
  runNpmInstall,
  runPackageJsonScript,
} = require('@now/build-utils/fs/run-user-scripts.js');

/** @typedef { import('@now/build-utils/file-ref') } FileRef */
/** @typedef {{[filePath: string]: FileRef}} Files */

/**
 * @typedef {Object} BuildParamsType
 * @property {Files} files - Files object
 * @property {string} entrypoint - Entrypoint specified for the builder
 * @property {string} workPath - Working directory for this build
 */

/**
 * @param {BuildParamsType} buildParams
 * @param {Object} [options]
 * @param {string[]} [options.npmArguments]
 */
async function downloadInstallAndBundle(
  { files, entrypoint, workPath },
  { npmArguments = [] } = {},
) {
  // 先定義路徑 workPath/user
  const userPath = path.join(workPath, 'user');
  // 先定義路徑 workPath/ncc
  const nccPath = path.join(workPath, 'ncc');

  console.log('downloading user files...');
  // 下載檔案到 workPath/user
  const downloadedFiles = await download(files, userPath);

  console.log('running npm install for user...');
  // 定義 entrypoint 的「資料夾」路徑 workpath/user/.../
  const entrypointFsDirname = path.join(userPath, path.dirname(entrypoint));
  // 在 entrypoint 的「資料夾」路徑中執行 npm install
  await runNpmInstall(entrypointFsDirname, npmArguments);

  console.log('writing ncc package.json...');
  // 下載 @zeit/ncc/package.json 到 workPath/ncc
  await download(
    {
      'package.json': new FileBlob({
        data: JSON.stringify({
          dependencies: {
            '@zeit/ncc': '0.4.1',
          },
        }),
      }),
    },
    nccPath,
  );

  console.log('running npm install for ncc...');
  // 在 ncc 的「資料夾」路徑中執行 npm install
  await runNpmInstall(nccPath, npmArguments);
  return [downloadedFiles, nccPath, entrypointFsDirname];
}

// 將 entrypoint 的檔案交比 ncc compile 得出 compiled 過的檔案
async function compile(workNccPath, downloadedFiles, entrypoint) {
  // input 為 entrypoint 的檔案路徑
  const input = downloadedFiles[entrypoint].fsPath;
  // ncc 的檔案路徑
  const ncc = require(path.join(workNccPath, 'node_modules/@zeit/ncc'));
  // 交比 ncc compile，得出 code 和 assets
  const { code, assets } = await ncc(input);

  // 定義準備檔案
  const preparedFiles = {};
  // 將 compiled 的 code 變成 blob 檔案
  const blob = new FileBlob({ data: code });
  // move all user code to 'user' subdirectory
  // 將 user/entrypoint 的檔案變成 blob (即已 compiled 的程式碼)
  preparedFiles[path.join('user', entrypoint)] = blob;
  // 將每個 assets 交返比 preparedFiles
  // eslint-disable-next-line no-restricted-syntax
  for (const assetName of Object.keys(assets)) {
    const blob2 = new FileBlob({ data: assets[assetName] });
    preparedFiles[
      path.join('user', path.dirname(entrypoint), assetName)
    ] = blob2;
  }

  // 輸出準備好的檔案
  return preparedFiles;
}

exports.config = {
  maxLambdaSize: '5mb',
};

/**
 * @param {BuildParamsType} buildParams
 * @returns {Promise<Files>}
 */
exports.build = async ({ files, entrypoint, workPath }) => {
  // 下載程式到 workPath/user，到 entrypoint 所在目錄 npm install
  // 下載 package.json 到 workPath/ncc，到 ncc 所在目錄 npm install
  const [
    downloadedFiles,
    workNccPath,
    entrypointFsDirname,
  ] = await downloadInstallAndBundle(
    { files, entrypoint, workPath },
    { npmArguments: ['--prefer-offline'] },
  );

  console.log('running user script...');
  // 在 entrypoint 所有資料夾中運行 package.json 中的 now-build script
  await runPackageJsonScript(entrypointFsDirname, 'now-build');

  console.log('compiling entrypoint with ncc...');
  // 將 entrypoint 的檔案交比 ncc compile 得出 compiled 過的檔案
  const preparedFiles = await compile(workNccPath, downloadedFiles, entrypoint);
  // 定義 launcher 路徑
  const launcherPath = path.join(__dirname, 'launcher.js');
  // 讀取 launcher.js 的內容
  let launcherData = await fs.readFile(launcherPath, 'utf8');

  // 取代 launcher 中的資料
  launcherData = launcherData.replace(
    '// PLACEHOLDER',
    [
      'process.chdir("./user");',
      `listener = require("./${path.join('user', entrypoint)}");`,
      'if (listener.default) listener = listener.default;',
    ].join(' '),
  );

  // 攞兩個檔案
  // 1. laucher.js 經修改過的
  // 2. 由 @now/node-bridge 中讀取 bridge.js
  const launcherFiles = {
    'launcher.js': new FileBlob({ data: launcherData }),
    'bridge.js': new FileFsRef({ fsPath: require('@now/node-bridge') }),
  };

  // 建立 lambda
  // 檔案:
  // 1. 將 entrypoint 的檔案交比 ncc compile 得出 compiled 過的檔案
  // 2. launcher.js 和 bridge.js
  const lambda = await createLambda({
    files: { ...preparedFiles, ...launcherFiles },
    handler: 'launcher.launcher',
    runtime: 'nodejs8.10',
  });

  // 將 lambda 交出來
  return { [entrypoint]: lambda };
};

// cachePath: a writable temporary directory where you can build a cache for the next run
exports.prepareCache = async ({
  files, entrypoint, workPath, cachePath,
}) => {
  // 將臨時資料夾刪除
  await fs.remove(workPath);
  // 下載程式到 workPath/user，到 entrypoint 所在目錄 npm install
  // 下載 package.json 到 workPath/ncc，到 ncc 所在目錄 npm install
  await downloadInstallAndBundle({ files, entrypoint, workPath: cachePath });

  return {
    // 將 user/node_modules 所有資料庫提取
    ...(await glob('user/node_modules/**', cachePath)),
    // 提取 user/package-lock.json
    ...(await glob('user/package-lock.json', cachePath)),
    // 提取 user/yarn.lock
    ...(await glob('user/yarn.lock', cachePath)),
    // 提取 ncc/node_modules
    ...(await glob('ncc/node_modules/**', cachePath)),
    // 提取 ncc/package-lock.json
    ...(await glob('ncc/package-lock.json', cachePath)),
    // 提取 ncc/yarn.lock
    ...(await glob('ncc/yarn.lock', cachePath)),
  };
};
