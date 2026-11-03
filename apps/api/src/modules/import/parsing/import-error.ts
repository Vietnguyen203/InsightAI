/**
 * A problem with the uploaded data itself (not a system failure). Import jobs that fail with
 * an ImportError are not retried; `code` and `message` are shown to the user.
 */
export class ImportError extends Error {
  constructor(
    readonly code:
      | 'UNSUPPORTED_FORMAT'
      | 'EMPTY_FILE'
      | 'TOO_MANY_ROWS'
      | 'TOO_MANY_COLUMNS'
      | 'SHEET_NOT_FOUND'
      | 'MALFORMED_FILE'
      | 'UNSAFE_ARCHIVE'
      | 'UNKNOWN_COLUMN',
    message: string,
  ) {
    super(message);
    this.name = 'ImportError';
  }
}

export interface ImportWarning {
  code: string;
  message: string;
  count?: number;
}
