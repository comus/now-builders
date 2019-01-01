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
const semver = require('semver');
const nextLegacyVersions = require('./legacy-versions');
const {
  excludeFiles,
  validateEntrypoint,
  includeOnlyEntryDirectory,
  moveEntryDirectoryToRoot,
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
  validateEntrypoint(entrypoint);

  console.log('downloading user files...');
  const entryDirectory = path.dirname(entrypoint);

  const userPath = path.join(workPath, 'user');
  const nccPath = path.join(workPath, 'ncc');

  const filesOnlyEntryDirectory = includeOnlyEntryDirectory(
    files,
    entryDirectory,
  );
  const filesWithEntryDirectoryRoot = moveEntryDirectoryToRoot(
    filesOnlyEntryDirectory,
    entryDirectory,
  );
  const filesWithoutStaticDirectory = excludeStaticDirectory(
    filesWithEntryDirectoryRoot,
  );
  const downloadedFiles = await download(filesWithoutStaticDirectory, userPath);

  const pkg = await readPackageJson(downloadedFiles);

  let nextVersion;
  if (pkg.dependencies && pkg.dependencies.next) {
    nextVersion = pkg.dependencies.next;
  } else if (pkg.devDependencies && pkg.devDependencies.next) {
    nextVersion = pkg.devDependencies.next;
  }

  if (!nextVersion) {
    throw new Error(
      'No Next.js version could be detected in "package.json". Make sure `"next"` is installed in "dependencies" or "devDependencies"',
    );
  }

  const isLegacy = (() => {
    // If version is using the dist-tag instead of a version range
    if (nextVersion === 'canary' || nextVersion === 'latest') {
      return false;
    }

    // If the version is an exact match with the legacy versions
    if (nextLegacyVersions.indexOf(nextVersion) !== -1) {
      return true;
    }

    const maxSatisfying = semver.maxSatisfying(nextLegacyVersions, nextVersion);
    // Matches latest canary
    if (maxSatisfying === '7.0.2-canary.50') {
      return false;
    }

    // When the version can't be matched with legacy versions, so it must be a newer version
    if (maxSatisfying === null) {
      return false;
    }

    // When 8.0.0 is released we can add it to the versions array
    // and check if the semver notation matches 8.0.0 to opt into the new mode

    return true;
  })();

  console.log(`MODE: ${isLegacy ? 'legacy' : 'serverless'}`);

  if (isLegacy) {
    try {
      await unlink(path.join(userPath, 'yarn.lock'));
    } catch (err) {
      console.log('no yarn.lock removed');
    }

    try {
      await unlink(path.join(userPath, 'package-lock.json'));
    } catch (err) {
      console.log('no package-lock.json removed');
    }

    console.warn(
      "WARNING: your application is being deployed in @now/next's legacy mode.",
    );
    console.log('normalizing package.json');
    const packageJson = normalizePackageJson(pkg);
    console.log('normalized package.json result: ', packageJson);
    await writePackageJson(userPath, packageJson);
  } else if (!pkg.scripts || !pkg.scripts['now-build']) {
    console.warn(
      'WARNING: "now-build" script not found. Adding \'"now-build": "next build"\' to "package.json" automatically',
    );
    pkg.scripts = {
      'now-build': 'next build',
      ...(pkg.scripts || {}),
    };
    console.log('normalized package.json result: ', pkg);
    await writePackageJson(userPath, pkg);
  }

  if (process.env.NPM_AUTH_TOKEN) {
    console.log('found NPM_AUTH_TOKEN in environment, creating .npmrc');
    await writeNpmRc(userPath, process.env.NPM_AUTH_TOKEN);
  }

  console.log('running npm install for user...');
  await runNpmInstall(userPath, ['--prefer-offline']);
  console.log('running user script...');
  await runPackageJsonScript(userPath, 'now-build');

  console.log('writing ncc package.json...');
  await download(
    {
      'package.json': new FileBlob({
        data: JSON.stringify({
          dependencies: {
            '@zeit/ncc': '0.6.0',
          },
        }),
      }),
    },
    nccPath,
  );
  console.log('running npm install for ncc...');
  await runNpmInstall(nccPath, ['--prefer-offline']);

  let blob;
  if (downloadedFiles['now.launcher.js']) {
    console.log('compiling now.launcher.js with ncc...');
    const input = downloadedFiles['now.launcher.js'].fsPath;
    const ncc = require(path.join(nccPath, 'node_modules/@zeit/ncc'));
    const { code } = await ncc(input);
    blob = new FileBlob({ data: code });
  } else if (downloadedFiles['now.launcher.ts']) {
    console.log('compiling now.launcher.ts with ncc...');
    const input = downloadedFiles['now.launcher.ts'].fsPath;
    const ncc = require(path.join(nccPath, 'node_modules/@zeit/ncc'));
    const { code } = await ncc(input);
    blob = new FileBlob({ data: code });
  }

  if (isLegacy) {
    console.log('running npm install --production...');
    await runNpmInstall(userPath, ['--prefer-offline', '--production']);
  }

  if (process.env.NPM_AUTH_TOKEN) {
    await unlink(path.join(userPath, '.npmrc'));
  }

  const lambdas = {};

  if (isLegacy) {
    const filesAfterBuild = await glob('**', userPath);

    console.log('preparing lambda files...');
    let buildId;
    try {
      buildId = await readFile(
        path.join(userPath, '.next', 'BUILD_ID'),
        'utf8',
      );
    } catch (err) {
      console.error(
        'BUILD_ID not found in ".next". The "package.json" "build" script did not run "next build"',
      );
      throw new Error('Missing BUILD_ID');
    }
    const dotNextRootFiles = await glob('.next/*', userPath);
    const dotNextServerRootFiles = await glob('.next/server/*', userPath);
    const nodeModules = excludeFiles(
      await glob('node_modules/**', userPath),
      file => file.startsWith('node_modules/.cache'),
    );
    const launcherFiles = {
      'now__bridge.js': new FileFsRef({ fsPath: require('@now/node-bridge') }),
    };

    const nextFiles = {
      ...nodeModules,
      ...dotNextRootFiles,
      ...dotNextServerRootFiles,
      ...launcherFiles,
    };
    if (filesAfterBuild['next.config.js']) {
      nextFiles['next.config.js'] = filesAfterBuild['next.config.js'];
    }

    if (blob) {
      nextFiles['now.launcher.js'] = blob;
    }

    const pages = await glob(
      '**/*.js',
      path.join(userPath, '.next', 'server', 'static', buildId, 'pages'),
    );
    const launcherPath = path.join(__dirname, 'legacy-launcher.js');
    const launcherData = await readFile(launcherPath, 'utf8');

    await Promise.all(
      Object.keys(pages).map(async (page) => {
        // These default pages don't have to be handled as they'd always 404
        if (['_app.js', '_error.js', '_document.js'].includes(page)) {
          return;
        }

        const pathname = page.replace(/\.js$/, '');
        const launcher = launcherData.replace(
          'PATHNAME_PLACEHOLDER',
          `/${pathname.replace(/(^|\/)index$/, '')}`,
        );

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
        lambdas[path.join(entryDirectory, pathname)] = await createLambda({
          files: {
            ...nextFiles,
            ...pageFiles,
            'now__launcher.js': new FileBlob({ data: launcher }),
          },
          handler: 'now__launcher.launcher',
          runtime: 'nodejs8.10',
        });
        console.log(`Created lambda for page: "${page}"`);
      }),
    );
  } else {
    console.log('preparing lambda files...');
    const launcherFiles = {
      'now__bridge.js': new FileFsRef({ fsPath: require('@now/node-bridge') }),
      'now__launcher.js': new FileFsRef({
        fsPath: path.join(__dirname, 'launcher.js'),
      }),
    };

    if (blob) {
      launcherFiles['now.launcher.js'] = blob;
    }

    const pages = await glob(
      '**/*.js',
      path.join(userPath, '.next', 'serverless', 'pages'),
    );

    const pageKeys = Object.keys(pages);

    if (pageKeys.length === 0) {
      throw new Error(
        'No serverless pages were built. https://err.sh/zeit/now-builders/now-next-no-serverless-pages-built',
      );
    }

    await Promise.all(
      pageKeys.map(async (page) => {
        // These default pages don't have to be handled as they'd always 404
        if (['_app.js', '_error.js', '_document.js'].includes(page)) {
          return;
        }

        const pathname = page.replace(/\.js$/, '');

        console.log(`Creating lambda for page: "${page}"...`);
        lambdas[path.join(entryDirectory, pathname)] = await createLambda({
          files: {
            ...launcherFiles,
            'page.js': pages[page],
          },
          handler: 'now__launcher.launcher',
          runtime: 'nodejs8.10',
        });
        console.log(`Created lambda for page: "${page}"`);
      }),
    );
  }

  const nextStaticFiles = await glob(
    '**',
    path.join(userPath, '.next', 'static'),
  );
  const staticFiles = Object.keys(nextStaticFiles).reduce(
    (mappedFiles, file) => ({
      ...mappedFiles,
      [path.join(entryDirectory, `_next/static/${file}`)]: nextStaticFiles[file],
    }),
    {},
  );

  const nextStaticDirectory = onlyStaticDirectory(filesWithEntryDirectoryRoot);
  const staticDirectoryFiles = Object.keys(nextStaticDirectory).reduce(
    (mappedFiles, file) => ({
      ...mappedFiles,
      [path.join(entryDirectory, file)]: nextStaticDirectory[file],
    }),
    {},
  );

  return { ...lambdas, ...staticFiles, ...staticDirectoryFiles };
};
