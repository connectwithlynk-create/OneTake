// Tiny shared env loader for CLI scripts. Pull .env from the desktop/
// directory (cwd when scripts are run via `npx tsx scripts/...` per
// our usual pattern). Node 20+ provides process.loadEnvFile, so no
// dotenv dependency. Silent no-op when .env doesn't exist.
import { existsSync } from 'fs';
import { resolve } from 'path';

const ENV_PATH = resolve(process.cwd(), '.env');

if (
  existsSync(ENV_PATH) &&
  typeof (process as { loadEnvFile?: (path: string) => void }).loadEnvFile ===
    'function'
) {
  try {
    (
      process as unknown as { loadEnvFile: (path: string) => void }
    ).loadEnvFile(ENV_PATH);
  } catch (err) {
    console.error(
      '[env] failed to load .env:',
      err instanceof Error ? err.message : String(err),
    );
  }
}
