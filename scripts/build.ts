// Builds standalone `pst` executables into dist/. They embed the Bun runtime, so people who
// install them need neither Bun nor Node.
//
//   bun run build        this machine only        -> dist/pst
//   bun run build:all    every release target     -> dist/pst-<os>-<arch>

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dir, '..');
const TARGETS = {
  'darwin-arm64': 'bun-darwin-arm64',
  'darwin-x64': 'bun-darwin-x64',
  'linux-x64': 'bun-linux-x64',
  'linux-arm64': 'bun-linux-arm64',
} as const;

async function compile(outfile: string, target?: string): Promise<void> {
  const cmd = [process.execPath, 'build', 'src/bin/pst.ts', '--compile', '--minify', '--outfile', outfile];
  if (target) cmd.push(`--target=${target}`);
  const proc = Bun.spawn(cmd, { cwd: ROOT, stdout: 'inherit', stderr: 'inherit' });
  if ((await proc.exited) !== 0) throw new Error(`build failed: ${outfile}`);
}

fs.rmSync(path.join(ROOT, 'dist'), { recursive: true, force: true });
if (process.argv.includes('--all')) {
  for (const [name, target] of Object.entries(TARGETS)) await compile(`dist/pst-${name}`, target);
} else {
  await compile('dist/pst');
}
