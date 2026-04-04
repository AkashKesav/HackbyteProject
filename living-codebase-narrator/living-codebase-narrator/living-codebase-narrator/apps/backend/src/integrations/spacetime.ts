import { env } from '../env.js';

export function isSpacetimeConfigured() {
  return Boolean(env.SPACETIME_SERVER_URL && env.SPACETIME_MODULE_NAME);
}
