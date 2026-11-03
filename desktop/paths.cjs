const path = require('node:path');

const MES_DATA_DIRECTORY = 'ForgeFlow MES';
const MES_DATABASE_FILE = 'mes-repository.sqlite';

function desktopPaths(appDataDirectory) {
  if (typeof appDataDirectory !== 'string' || !path.isAbsolute(appDataDirectory)) {
    throw new Error('Electron appData path must be absolute.');
  }
  const userData = path.join(appDataDirectory, MES_DATA_DIRECTORY);
  return Object.freeze({
    userData,
    database: path.join(userData, MES_DATABASE_FILE),
  });
}

module.exports = { desktopPaths };
