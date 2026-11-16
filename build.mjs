// Bundles the extension into dist/. Usage: node build.mjs [--watch]
// App Check debug token: read from appcheck-debug-token.local (git-ignored) or APPCHECK_DEBUG_TOKEN.
// Production App Check endpoint: APPCHECK_EXCHANGE_URL (optional).
import * as esbuild from 'esbuild';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';

const tokenFile = 'appcheck-debug-token.local';
const debugToken = process.env.APPCHECK_DEBUG_TOKEN || (existsSync(tokenFile) ? readFileSync(tokenFile, 'utf8').trim() : '');
const exchangeUrl = process.env.APPCHECK_EXCHANGE_URL || '';

rmSync('dist', { recursive: true, force: true });
mkdirSync('dist', { recursive: true });
cpSync('static', 'dist', { recursive: true });

const common = {
  bundle: true,
  target: 'chrome138',
  legalComments: 'none',
  logLevel: 'info',
  define: {
    __APPCHECK_DEBUG_TOKEN__: JSON.stringify(debugToken),
    __APPCHECK_EXCHANGE_URL__: JSON.stringify(exchangeUrl)
  }
};

const builds = [
  { entryPoints: ['src/sidepanel.js'], outfile: 'dist/sidepanel.js', format: 'esm' },
  { entryPoints: ['src/background.js'], outfile: 'dist/background.js', format: 'esm' },
  { entryPoints: ['src/content.js'], outfile: 'dist/content.js', format: 'iife' }
];

if (process.argv.includes('--watch')) {
  for (const b of builds) (await esbuild.context({ ...common, ...b })).watch();
} else {
  await Promise.all(builds.map((b) => esbuild.build({ ...common, ...b })));
  console.log(`App Check: ${debugToken ? 'debug token build (do not publish this build)' : exchangeUrl ? 'custom provider build' : 'no provider configured'}`);
}
