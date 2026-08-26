/** A deliberate, expected error with a specific HTTP status — thrown from route handlers and
 * caught by the central error handler, as opposed to an unexpected bug (which falls through to a
 * generic 500). `code` is optional and only worth setting when a CLIENT needs to programmatically
 * distinguish this error from any other same-status error rather than just displaying `message` —
 * e.g. APP's api.ts needs to tell "locked outside working hours" apart from an ordinary
 * permission-denied 403 so it can redirect instead of just showing an inline error. */
export class HttpError extends Error {
  status: number;
  code?: string;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.name = "HttpError";
  }
}

export class NotFoundError extends HttpError {
  constructor(message = "Not found") {
    super(404, message);
    this.name = "NotFoundError";
  }
}

export class ConflictError extends HttpError {
  constructor(message = "Conflict") {
    super(409, message);
    this.name = "ConflictError";
  }
}
