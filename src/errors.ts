export class WotonError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = this.constructor.name;
    this.code = code;
  }
}

export class WotonSecurityError extends WotonError {
  constructor(message: string, options?: ErrorOptions) {
    super("WOTON_SECURITY", message, options);
  }
}

export class WotonFileError extends WotonError {
  constructor(message: string, options?: ErrorOptions) {
    super("WOTON_FILE", message, options);
  }
}

export class WotonQueryError extends WotonError {
  constructor(message: string, options?: ErrorOptions) {
    super("WOTON_QUERY", message, options);
  }
}

export class WotonValidationError extends WotonError {
  constructor(message: string, options?: ErrorOptions) {
    super("WOTON_VALIDATION", message, options);
  }
}
