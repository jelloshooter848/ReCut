/**
 * The app's environment variables, read through one helper so every variable is accepted under each prefix in
 * shared/productIdentity.ts ENV_PREFIXES (today only `RECUT_`, which is kept forever). Call sites name the variable
 * without its prefix: `envVar('CACHE_DIR')` reads `RECUT_CACHE_DIR`.
 */
import { readPrefixedEnv } from '../shared/productIdentity';

/** The value of `<prefix><name>` for the first prefix that sets it to a non-empty value; undefined when none does. */
export function envVar(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return readPrefixedEnv(env, name);
}

/** Whether `<prefix><name>` is set to exactly `value` (e.g. `envIs('SMOKE', '1')`). */
export function envIs(name: string, value: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return envVar(name, env) === value;
}
