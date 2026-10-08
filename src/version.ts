import pkg from '../package.json' with { type: 'json' };

/** Bundled into the compiled binary at build time. */
export const VERSION: string = pkg.version;
