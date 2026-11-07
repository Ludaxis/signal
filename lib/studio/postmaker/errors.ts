// Post maker errors: an HTTP-like status (routes map it directly, like ContentError) plus a stable machine code
// that tests and the UI can branch on. Messages are short, plain sentences shown to the user.
export class PostmakerError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'PostmakerError';
  }
}

export const isPostmakerError = (e: unknown, code?: string): e is PostmakerError =>
  e instanceof PostmakerError && (code === undefined || e.code === code);
