const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const packageJson = require('../desktop/package.json');
const { desktopPaths } = require('../desktop/paths.cjs');

test('MES desktop package has its own operating-system identity', () => {
  assert.equal(packageJson.build.appId, 'org.blockchen.forgeflow.mes');
  assert.equal(packageJson.build.productName, 'ForgeFlow MES');
});

test('MES desktop data is isolated under its own app-data directory', () => {
  const appData = path.resolve('fixture-app-data');
  const paths = desktopPaths(appData);

  assert.equal(paths.userData, path.join(appData, 'ForgeFlow MES'));
  assert.equal(paths.database, path.join(appData, 'ForgeFlow MES', 'mes-repository.sqlite'));
  assert.equal(path.dirname(paths.database), paths.userData);
  assert.notEqual(paths.database, path.join(appData, 'Business Suite', 'suite.sqlite'));
});

test('MES desktop paths reject relative app-data directories', () => {
  assert.throws(() => desktopPaths('relative-app-data'), /must be absolute/);
});
