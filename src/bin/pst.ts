#!/usr/bin/env bun
import { main } from '../cli.ts';
import { VaultError, errorMessage } from '../errors.ts';

main(process.argv.slice(2)).catch((err: unknown) => {
  console.error(`pst: ${errorMessage(err)}`);
  process.exit(err instanceof VaultError && err.status < 500 ? 2 : 1);
});
