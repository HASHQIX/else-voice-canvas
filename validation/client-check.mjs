import { spawnSync } from 'node:child_process';
const result = spawnSync(process.execPath, ['--import', 'tsx', 'validation/field-browser.mjs'], { stdio: 'inherit' });
process.exitCode = result.status ?? 1;
