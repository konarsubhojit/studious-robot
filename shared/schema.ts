// @ts-check
'use strict';

/**
 * Minimal, dependency-free schema validation with a `zod`-compatible surface.
 *
 * Only the subset the wire contracts need is implemented: `safeParse`, the
 * object/string/number/boolean/literal/array/record/union combinators and the
 * `.optional()` / `.nullable()` modifiers.  Results use zod's shape —
 * `{ success: true, data }` or `{ success: false, error: { message, path } }` —
 * so call sites read identically if this is ever swapped for `zod` itself.
 *
 * See `shared/README.md` for why the shared package carries no dependencies.
 */

export type ParseSuccess = { success: true; data: any; };
export type ParseFailure = { success: false; error: { message: string; path: string; }; };
export type ParseResult = ParseSuccess | ParseFailure;
export type Schema = { isOptional: boolean; _parse: (value: unknown, path: string) => ParseResult; safeParse: (value: unknown) => ParseResult; parse: (value: unknown) => any; optional: () => Schema; nullable: () => Schema; };

/** @param {string} path @param {string} message @returns {ParseFailure} */
function fail(path: string, message: string): ParseFailure {
  return {
    success: false,
    error: { message: path ? `${path}: ${message}` : message, path },
  };
}

/** @param {any} data @returns {ParseSuccess} */
function ok(data: any): ParseSuccess {
  return { success: true, data };
}

/** @param {string} path @param {string|number} key */
function joinPath(path: string, key: string | number) {
  return path ? `${path}.${key}` : String(key);
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
function isPlainObject(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Wrap a `(value, path) => ParseResult` function in the chainable schema API.
 *
 * @param {(value: unknown, path: string) => ParseResult} parse
 * @param {{ isOptional?: boolean }} [meta]
 * @returns {Schema}
 */
function createSchema(parse: (value: unknown, path: string) => ParseResult, meta: { isOptional?: boolean; } = {}): Schema {
  const schema = {
    ...meta,
    isOptional: Boolean(meta.isOptional),
    _parse: parse,
    /** @param {unknown} value @returns {ParseResult} */
    safeParse(value: unknown): ParseResult {
      return parse(value, '');
    },
    /** @param {unknown} value @returns {any} Throws `TypeError` when invalid. */
    parse(value: unknown): any {
      const result = parse(value, '');
      if (!result.success) {
        throw new TypeError(result.error.message);
      }
      return result.data;
    },
    /** Accept `undefined` (and a missing object key) in addition to the base type. */
    optional() {
      return createSchema(
        (value, path) => (value === undefined ? ok(undefined) : parse(value, path)),
        { ...meta, isOptional: true }
      );
    },
    /** Accept `null` in addition to the base type. */
    nullable() {
      return createSchema((value, path) => (value === null ? ok(null) : parse(value, path)), {
        ...meta,
        isOptional: Boolean(meta.isOptional),
      });
    },
  };
  return schema;
}

/** Any value, including `undefined`. */
function unknown() {
  return createSchema((value) => ok(value), { isOptional: true });
}

function string({ min = 0, max = Number.MAX_SAFE_INTEGER, trim = false } = {}) {
  return createSchema((value, path) => {
    if (typeof value !== 'string') return fail(path, 'expected a string');
    const parsed = trim ? value.trim() : value;
    if (parsed.length < min) return fail(path, `expected at least ${min} character(s)`);
    if (parsed.length > max) return fail(path, `expected at most ${max} character(s)`);
    return ok(parsed);
  });
}

/** Non-empty, trimmed identifier (userId, callId, deviceId, …). */
function id({ max = 128 } = {}) {
  return string({ min: 1, max, trim: true });
}

function number({ min = -Infinity, max = Infinity, integer = false } = {}) {
  return createSchema((value, path) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return fail(path, 'expected a finite number');
    }
    if (integer && !Number.isInteger(value)) return fail(path, 'expected an integer');
    if (value < min) return fail(path, `expected >= ${min}`);
    if (value > max) return fail(path, `expected <= ${max}`);
    return ok(value);
  });
}

function boolean() {
  return createSchema((value, path) =>
    typeof value === 'boolean' ? ok(value) : fail(path, 'expected a boolean')
  );
}

/** @param {string|number|boolean} expected */
function literal(expected: string | number | boolean) {
  return createSchema((value, path) =>
    value === expected ? ok(value) : fail(path, `expected ${JSON.stringify(expected)}`)
  );
}

/** @param {ReadonlyArray<string>} values */
function enumOf(values: ReadonlyArray<string>) {
  const allowed = new Set(values);
  return createSchema((value, path) =>
    allowed.has(/** @type {string} */ (value))
      ? ok(value)
      : fail(path, `expected one of ${[...allowed].join(', ')}`)
  );
}

/** @param {Schema} item */
function array(item: Schema) {
  return createSchema((value, path) => {
    if (!Array.isArray(value)) return fail(path, 'expected an array');
    /** @type {any[]} */
    const parsed: any[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const result = item._parse(value[index], joinPath(path, `[${index}]`));
      if (!result.success) return result;
      parsed.push(result.data);
    }
    return ok(parsed);
  });
}

/**
 * Object schema. Unknown keys are stripped (zod's default), so a newer peer
 * adding a field can never smuggle unexpected data into a handler.
 *
 * @param {Record<string, Schema>} shape
 * @param {{ passthrough?: boolean }} [options] - `passthrough` keeps unknown
 *   keys, used for records whose full shape is owned by one side only.
 */
function object(shape: Record<string, Schema>, { passthrough = false }: { passthrough?: boolean; } = {}) {
  return createSchema((value, path) => {
    if (!isPlainObject(value)) return fail(path, 'expected an object');
    /** @type {Record<string, any>} */
    const parsed: Record<string, any> = passthrough ? { ...value } : {};
    for (const [key, keySchema] of Object.entries(shape)) {
      const result = keySchema._parse(value[key], joinPath(path, key));
      if (!result.success) return result;
      if (result.data !== undefined || key in value) {
        parsed[key] = result.data;
      }
    }
    return ok(parsed);
  });
}

/**
 * A non-null, non-array object whose internal shape belongs to another layer
 * (SDP descriptions, ICE candidates, …). The value is returned by reference so
 * host objects such as `RTCSessionDescription` survive validation intact.
 */
function opaque() {
  return createSchema((value, path) =>
    isPlainObject(value) ? ok(value) : fail(path, 'expected an object')
  );
}

/**
 * Object with arbitrary string keys and uniformly typed values.
 *
 * @param {Schema} valueSchema
 */
function record(valueSchema: Schema) {
  return createSchema((value, path) => {
    if (!isPlainObject(value)) return fail(path, 'expected an object');
    /** @type {Record<string, any>} */
    const parsed: Record<string, any> = {};
    for (const [key, entry] of Object.entries(value)) {
      const result = valueSchema._parse(entry, joinPath(path, key));
      if (!result.success) return result;
      parsed[key] = result.data;
    }
    return ok(parsed);
  });
}

/** @param {Schema[]} options */
function union(options: Schema[]) {
  return createSchema((value, path) => {
    for (const option of options) {
      const result = option._parse(value, path);
      if (result.success) return result;
    }
    return fail(path, 'did not match any allowed variant');
  });
}

const s = {
  array,
  boolean,
  enum: enumOf,
  id,
  literal,
  number,
  object,
  opaque,
  record,
  string,
  union,
  unknown,
};

module.exports = { s, isPlainObject };
