import { resolve } from 'node:path';

export const ROOT = resolve(import.meta.dirname, '..');

/** 读取 .env（Node 22 自带，不需要 dotenv）。不存在也没关系 */
export function loadEnv() {
  try {
    process.loadEnvFile(resolve(ROOT, '.env'));
  } catch {
    /* 没有 .env 就全部走 mock */
  }
}
