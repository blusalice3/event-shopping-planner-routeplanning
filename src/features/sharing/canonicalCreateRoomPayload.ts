import { canonicalize } from 'json-canonicalize';
import { MAX_CANONICAL_CREATE_PAYLOAD_BYTES } from './contracts';

export type CanonicalJsonValue =
  | null
  | boolean
  | number
  | string
  | CanonicalJsonValue[]
  | { [key: string]: CanonicalJsonValue };

export type CanonicalPayloadFailureReason =
  | 'INVALID_UTF8'
  | 'INVALID_JSON'
  | 'INVALID_SCHEMA'
  | 'DUPLICATE_KEY'
  | 'NFC_DUPLICATE_KEY'
  | 'LONE_SURROGATE'
  | 'NON_FINITE_NUMBER'
  | 'PAYLOAD_TOO_LARGE';

export class CanonicalPayloadError extends Error {
  constructor(
    public readonly reason: CanonicalPayloadFailureReason,
    message: string,
  ) {
    super(message);
    this.name = 'CanonicalPayloadError';
  }
}

export type CanonicalCreateRoomPayload = {
  value: CanonicalJsonValue;
  canonicalText: string;
  canonicalBytes: Uint8Array;
  fingerprint: string;
  plaintextSizeBytes: number;
};

export type CanonicalCreateRoomPayloadOptions = {
  validate?: (value: CanonicalJsonValue) => void;
};

class StrictJsonParser {
  private index = 0;

  constructor(private readonly source: string) {}

  parse(): CanonicalJsonValue {
    this.skipWhitespace();
    const value = this.parseValue();
    this.skipWhitespace();
    if (this.index !== this.source.length) {
      this.fail('Unexpected content after the JSON value.');
    }
    return value;
  }

  private parseValue(): CanonicalJsonValue {
    const current = this.source[this.index];
    switch (current) {
      case '{':
        return this.parseObject();
      case '[':
        return this.parseArray();
      case '"':
        return this.parseString();
      case 't':
        return this.parseLiteral('true', true);
      case 'f':
        return this.parseLiteral('false', false);
      case 'n':
        return this.parseLiteral('null', null);
      default:
        if (current === '-' || (current >= '0' && current <= '9')) {
          return this.parseNumber();
        }
        this.fail('Expected a JSON value.');
    }
  }

  private parseObject(): { [key: string]: CanonicalJsonValue } {
    const result = Object.create(null) as { [key: string]: CanonicalJsonValue };
    const keys = new Set<string>();
    this.index++;
    this.skipWhitespace();
    if (this.consume('}')) {
      return result;
    }

    while (true) {
      if (this.source[this.index] !== '"') {
        this.fail('Expected an object key.');
      }
      const key = this.parseString();
      if (keys.has(key)) {
        throw new CanonicalPayloadError(
          'DUPLICATE_KEY',
          `Duplicate JSON object key: ${key}`,
        );
      }
      keys.add(key);
      this.skipWhitespace();
      if (!this.consume(':')) {
        this.fail('Expected ":" after an object key.');
      }
      this.skipWhitespace();
      result[key] = this.parseValue();
      this.skipWhitespace();
      if (this.consume('}')) {
        return result;
      }
      if (!this.consume(',')) {
        this.fail('Expected "," or "}" in an object.');
      }
      this.skipWhitespace();
    }
  }

  private parseArray(): CanonicalJsonValue[] {
    const result: CanonicalJsonValue[] = [];
    this.index++;
    this.skipWhitespace();
    if (this.consume(']')) {
      return result;
    }

    while (true) {
      result.push(this.parseValue());
      this.skipWhitespace();
      if (this.consume(']')) {
        return result;
      }
      if (!this.consume(',')) {
        this.fail('Expected "," or "]" in an array.');
      }
      this.skipWhitespace();
    }
  }

  private parseString(): string {
    const start = this.index;
    this.index++;

    while (this.index < this.source.length) {
      const char = this.source[this.index];
      if (char === '"') {
        this.index++;
        const value = JSON.parse(
          this.source.slice(start, this.index),
        ) as string;
        assertNoLoneSurrogate(value);
        return value;
      }
      if (char.charCodeAt(0) < 0x20) {
        this.fail('Unescaped control character in a string.');
      }
      if (char === '\\') {
        this.index++;
        const escape = this.source[this.index];
        if (escape === 'u') {
          const hex = this.source.slice(this.index + 1, this.index + 5);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
            this.fail('Invalid Unicode escape.');
          }
          this.index += 5;
          continue;
        }
        if (!escape || !'"\\/bfnrt'.includes(escape)) {
          this.fail('Invalid string escape.');
        }
      }
      this.index++;
    }

    this.fail('Unterminated string.');
  }

  private parseNumber(): number {
    const match = this.source
      .slice(this.index)
      .match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
    if (!match) {
      this.fail('Invalid JSON number.');
    }
    this.index += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) {
      throw new CanonicalPayloadError(
        'NON_FINITE_NUMBER',
        'JSON number must be finite.',
      );
    }
    return Object.is(value, -0) ? 0 : value;
  }

  private parseLiteral<T extends boolean | null>(literal: string, value: T): T {
    if (!this.source.startsWith(literal, this.index)) {
      this.fail(`Expected "${literal}".`);
    }
    this.index += literal.length;
    return value;
  }

  private consume(expected: string): boolean {
    if (this.source[this.index] !== expected) {
      return false;
    }
    this.index++;
    return true;
  }

  private skipWhitespace(): void {
    while (
      this.source[this.index] === ' ' ||
      this.source[this.index] === '\n' ||
      this.source[this.index] === '\r' ||
      this.source[this.index] === '\t'
    ) {
      this.index++;
    }
  }

  private fail(message: string): never {
    throw new CanonicalPayloadError(
      'INVALID_JSON',
      `${message} (offset ${this.index})`,
    );
  }
}

const assertNoLoneSurrogate = (value: string): void => {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new CanonicalPayloadError(
          'LONE_SURROGATE',
          'String contains a lone high surrogate.',
        );
      }
      index++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new CanonicalPayloadError(
        'LONE_SURROGATE',
        'String contains a lone low surrogate.',
      );
    }
  }
};

const normalizeNfc = (value: CanonicalJsonValue): CanonicalJsonValue => {
  if (typeof value === 'string') {
    return value.normalize('NFC');
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new CanonicalPayloadError(
        'NON_FINITE_NUMBER',
        'JSON number must be finite.',
      );
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    return value.map(normalizeNfc);
  }
  if (value && typeof value === 'object') {
    const normalized = Object.create(null) as {
      [key: string]: CanonicalJsonValue;
    };
    const normalizedKeys = new Set<string>();
    for (const [key, child] of Object.entries(value)) {
      const normalizedKey = key.normalize('NFC');
      if (normalizedKeys.has(normalizedKey)) {
        throw new CanonicalPayloadError(
          'NFC_DUPLICATE_KEY',
          `Object keys become duplicates after NFC normalization: ${normalizedKey}`,
        );
      }
      normalizedKeys.add(normalizedKey);
      normalized[normalizedKey] = normalizeNfc(child);
    }
    return normalized;
  }
  return value;
};

const toBase64Url = (bytes: Uint8Array): string => {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/u, '');
};

const sha256Base64Url = async (bytes: Uint8Array): Promise<string> => {
  const digestInput = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  const digest = await globalThis.crypto.subtle.digest('SHA-256', digestInput);
  return toBase64Url(new Uint8Array(digest));
};

export const parseStrictJson = (rawJson: string): CanonicalJsonValue =>
  new StrictJsonParser(rawJson).parse();

export const canonicalCreateRoomPayload = async (
  rawJson: string,
  options: CanonicalCreateRoomPayloadOptions = {},
): Promise<CanonicalCreateRoomPayload> => {
  const parsed = parseStrictJson(rawJson);
  const value = normalizeNfc(parsed);

  try {
    options.validate?.(value);
  } catch (error) {
    if (error instanceof CanonicalPayloadError) {
      throw error;
    }
    throw new CanonicalPayloadError(
      'INVALID_SCHEMA',
      error instanceof Error
        ? error.message
        : 'Payload failed runtime schema validation.',
    );
  }

  const canonicalText = canonicalize(value);
  const canonicalBytes = new TextEncoder().encode(canonicalText);

  if (canonicalBytes.byteLength > MAX_CANONICAL_CREATE_PAYLOAD_BYTES) {
    throw new CanonicalPayloadError(
      'PAYLOAD_TOO_LARGE',
      `Canonical payload exceeds ${MAX_CANONICAL_CREATE_PAYLOAD_BYTES} bytes.`,
    );
  }

  return {
    value,
    canonicalText,
    canonicalBytes,
    fingerprint: await sha256Base64Url(canonicalBytes),
    plaintextSizeBytes: canonicalBytes.byteLength,
  };
};

export const canonicalCreateRoomPayloadFromBytes = async (
  rawBytes: Uint8Array,
  options: CanonicalCreateRoomPayloadOptions = {},
): Promise<CanonicalCreateRoomPayload> => {
  let rawJson: string;
  try {
    rawJson = new TextDecoder('utf-8', { fatal: true }).decode(rawBytes);
  } catch {
    throw new CanonicalPayloadError(
      'INVALID_UTF8',
      'Payload is not valid UTF-8.',
    );
  }
  return canonicalCreateRoomPayload(rawJson, options);
};
