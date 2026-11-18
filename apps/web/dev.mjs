import { createRequire } from 'node:module';
import { loadEnvFile } from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

try {
  loadEnvFile(fileURLToPath(new URL('../../.env', import.meta.url)));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

const require = createRequire(import.meta.url);
await import(pathToFileURL(require.resolve('next/dist/bin/next')).href);
