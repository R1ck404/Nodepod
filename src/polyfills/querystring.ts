// Querystring parse/stringify/escape/unescape


export type ParsedQuery = Record<string, string | string[]>;

/** Node-style unescape: invalid % sequences are left literal. */
function decodeLenient(text: string): string {
  const plusDecoded = text.replace(/\+/g, " ");
  try {
    return decodeURIComponent(plusDecoded);
  } catch {
    // Fall back to percent-decoding valid sequences only
    return plusDecoded.replace(/%([0-9A-Fa-f]{2})/g, (_m, hex: string) =>
      String.fromCharCode(parseInt(hex, 16)),
    );
  }
}

// supports duplicate keys (values become arrays) and custom separators
export function parse(
  input: string,
  pairSep: string = '&',
  kvSep: string = '=',
  options?: { maxKeys?: number }
): ParsedQuery {
  const output: ParsedQuery = Object.create(null);
  if (!input || typeof input !== 'string') return output;

  const ceiling = options?.maxKeys || 1000;
  const segments = input.split(pairSep);
  const limit = ceiling > 0 ? Math.min(segments.length, ceiling) : segments.length;

  for (let i = 0; i < limit; i++) {
    const segment = segments[i];
    const eqPos = segment.indexOf(kvSep);
    let k: string;
    let v: string;

    if (eqPos >= 0) {
      k = decodeLenient(segment.substring(0, eqPos));
      v = decodeLenient(segment.substring(eqPos + 1));
    } else {
      k = decodeLenient(segment);
      v = '';
    }

    if (k in output) {
      const prev = output[k];
      if (Array.isArray(prev)) {
        prev.push(v);
      } else {
        output[k] = [prev, v];
      }
    } else {
      output[k] = v;
    }
  }

  return output;
}

// Node only serializes primitive values. In particular, an undefined own
// property is an empty value, not an omitted key. Loader option round-trips
// rely on the distinction between an absent option and an empty one.
function stringifyPrimitive(value: unknown): string {
  switch (typeof value) {
    case "string": return value;
    case "boolean": return value ? "true" : "false";
    case "bigint": return String(value);
    case "number": return Number.isFinite(value) ? String(value) : "";
    default: return "";
  }
}

export function stringify(
  obj: Record<string, unknown>,
  pairSep: string = '&',
  kvSep: string = '='
): string {
  if (!obj || typeof obj !== 'object') return '';

  const parts: string[] = [];

  for (const [key, val] of Object.entries(obj)) {
    const encodedKey = encodeURIComponent(key);

    if (Array.isArray(val)) {
      for (const item of val) {
        parts.push(`${encodedKey}${kvSep}${encodeURIComponent(stringifyPrimitive(item))}`);
      }
    } else {
      parts.push(`${encodedKey}${kvSep}${encodeURIComponent(stringifyPrimitive(val))}`);
    }
  }

  return parts.join(pairSep);
}

export function escape(text: string): string {
  return encodeURIComponent(text);
}

export function unescape(text: string): string {
  return decodeLenient(text);
}

// Node.js compatibility aliases
export const encode = stringify;
export const decode = parse;

export default {
  parse,
  stringify,
  escape,
  unescape,
  encode,
  decode,
};
