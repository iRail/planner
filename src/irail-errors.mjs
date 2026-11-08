/** An error response of the iRail-style API: `status` is the HTTP status the real API would use. */
export class IrailApiError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "IrailApiError";
    this.status = status;
  }
}

/** A call that exists in the iRail API but that this library cannot answer yet. */
export class NotSupportedError extends IrailApiError {
  constructor(call, reason) {
    super(501, `${call} is not supported yet: ${reason}`);
    this.name = "NotSupportedError";
    this.call = call;
  }
}
