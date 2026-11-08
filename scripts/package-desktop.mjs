import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';

function run(cmd, args, options = {}) {
  const isWinCmd = process.platform === 'win32' && (cmd.endsWith('.cmd') || cmd.endsWith('.bat'));
  const r = spawnSync(cmd, args, {
    stdio: 'inherit',
    shell: isWinCmd,
    ...options
  });
  if (r.status !== 0) {
    process.exit(r.status || 1);
  }
}

console.log('[package-desktop] Building Rust desktop binary for ForgeFlow MES...');
run('cargo', ['build', '--release', '--manifest-path', 'desktop/Cargo.toml']);

const outputDir = path.resolve('outputs/desktop/win-unpacked');
const resourcesDir = path.join(outputDir, 'resources');
const backendDir = path.join(resourcesDir, 'backend');
const webDir = path.join(resourcesDir, 'web');

mkdirSync(backendDir, { recursive: true });
mkdirSync(webDir, { recursive: true });

const rustBin = path.resolve('desktop/target/release/forgeflow-mes-desktop.exe');
const targetExe = path.join(outputDir, 'ForgeFlow MES.exe');
if (existsSync(rustBin)) {
  console.log(`[package-desktop] Copying ${rustBin} -> ${targetExe}`);
  cpSync(rustBin, targetExe);
} else {
  console.error(`[package-desktop] Error: Rust binary not found at ${rustBin}`);
  process.exit(1);
}

const goBin = path.resolve('outputs/go/business-suite.exe');
if (existsSync(goBin)) {
  console.log(`[package-desktop] Copying ${goBin} -> ${path.join(backendDir, 'business-suite.exe')}`);
  cpSync(goBin, path.join(backendDir, 'business-suite.exe'));
} else {
  console.warn(`[package-desktop] Warning: Go binary not found at ${goBin}`);
}

const webDist = path.resolve('web-dist');
if (existsSync(webDist)) {
  console.log(`[package-desktop] Copying ${webDist} -> ${webDir}`);
  cpSync(webDist, webDir, { recursive: true });
} else {
  console.warn(`[package-desktop] Warning: web-dist not found at ${webDist}`);
}

console.log('[package-desktop] Successfully packaged ForgeFlow MES Rust desktop application to:', outputDir);
