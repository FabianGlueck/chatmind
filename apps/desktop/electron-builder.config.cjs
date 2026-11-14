// Desktop spec §1. The app is the staging folder from scripts/build.mjs; its node_modules are already
// complete, so electron-builder neither installs nor rebuilds anything.
const electronVersion = require('electron/package.json').version;

module.exports = {
  appId: 'md.chatmind.app',
  productName: 'chatmind',
  electronVersion,
  directories: { app: 'build/app', output: 'release' },
  npmRebuild: false,
  nodeGypRebuild: false,
  // sqlite-vec hands SQLite a path to its .dylib, and native code cannot read from inside an asar archive.
  asar: false,
  files: ['**/*', '!**/*.map'],
  mac: {
    category: 'public.app-category.productivity',
    target: ['dmg', 'zip'],
    identity: null, // unsigned until a Developer ID is set up (spec §5)
  },
  win: { target: 'nsis' },
  linux: { target: 'AppImage', category: 'Office' },
};
