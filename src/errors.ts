/** An error that is safe to show to the caller; `status` doubles as the HTTP status. */
export class VaultError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));
