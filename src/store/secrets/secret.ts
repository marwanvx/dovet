const REDACTED = "[redacted]";

/** A credential value that shows as "[redacted]" wherever it is printed, logged or serialized; only `reveal()` returns it. */
export class Secret {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  [Bun.inspect.custom](): string {
    return `Secret(${REDACTED})`;
  }
}
