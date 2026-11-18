import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const result = spawnSync(process.execPath, [require.resolve('next/dist/bin/next'), 'build'], {
  stdio: 'inherit',
  env: {
    ...process.env,
    MWITU_STATIC_EXPORT: '1',
    NEXT_PUBLIC_API_ORIGIN: process.env.NEXT_PUBLIC_API_ORIGIN || 'https://api.tiktokmwitu.co.ke',
  },
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
