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

export type ParseSuccess<T> = { success: true; data: T; };
export type ParseFailure = { success: false; error: { message: string; path: string; }; };
export type ParseResult<T = unknown> = ParseSuccess<T> | ParseFailure;
export type Schema<T = unknown> = {
  isOptional: boolean;
  _parse: (value: unknown, path: string) => ParseResult<T>;
  safeParse: (value: unknown) => ParseResult<T>;
  parse: (value: unknown) => T;
  optional: () => Schema<T | undefined>;
  nullable: () => Schema<T | null>;
};

function fail(path: string, message: string): ParseFailure {
  return {
    success: false,
    error: { message: path ? `${path}: ${message}` : message, path },
  };
}

function ok<T>(data: T): ParseSuccess<T> {
  return { success: true, data };
}

function joinPath(path: string, key: string | number) {
  return path ? `${path}.${key}` : String(key);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Wrap a `(value, path) => ParseResult` function in the chainable schema API.
 */
function createSchema<T>(parse: (value: unknown, path: string) => ParseResult<T>, meta: { isOptional?: boolean; } = {}): Schema<T> {
  const schema: Schema<T> = {
    ...meta,
    isOptional: Boolean(meta.isOptional),
    _parse: parse,
    safeParse(value: unknown): ParseResult<T> {
      return parse(value, '');
    },
    /** Throws `TypeError` when invalid. */
    parse(value: unknown): T {
      const result = parse(value, '');
      if (!result.success) {
        throw new TypeError(result.error.message);
      }
      return result.data;
    },
    /** Accept `undefined` (and a missing object key) in addition to the base type. */
    optional(): Schema<T | undefined> {
      return createSchema<T | undefined>(
        (value, path) => (value === undefined ? ok(undefined) : parse(value, path)),
        { ...meta, isOptional: true }
      );
    },
    /** Accept `null` in addition to the base type. */
    nullable(): Schema<T | null> {
      return createSchema<T | null>((value, path) => (value === null ? ok(null) : parse(value, path)), {
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

/** @param expected */
function literal<T extends string | number | boolean>(expected: T) {
  return createSchema((value, path) =>
    value === expected ? ok(value as T) : fail(path, `expected ${JSON.stringify(expected)}`)
  );
}

/** @param values */
function enumOf<T extends string>(values: ReadonlyArray<T>) {
  const allowed = new Set(values);
  return createSchema((value, path) =>
    typeof value === 'string' && allowed.has(value as T)
      ? ok(value as T)
      : fail(path, `expected one of ${[...allowed].join(', ')}`)
  );
}

/** @param item */
function array<T>(item: Schema<T>) {
  return createSchema((value, path) => {
    if (!Array.isArray(value)) return fail(path, 'expected an array');
    const parsed: T[] = [];
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
 * @param options - `passthrough` keeps unknown
 *   keys, used for records whose full shape is owned by one side only.
 */
type SchemaType<S extends Schema<unknown>> = S extends Schema<infer T> ? T : never;
type SchemaShape = Record<string, Schema<unknown>>;
type OptionalKeys<TShape extends SchemaShape> = {
  [K in keyof TShape]-?: undefined extends SchemaType<TShape[K]> ? K : never;
}[keyof TShape];
type RequiredKeys<TShape extends SchemaShape> = Exclude<keyof TShape, OptionalKeys<TShape>>;
type InferObject<TShape extends SchemaShape, TPassthrough extends boolean> = {
  [K in RequiredKeys<TShape>]: SchemaType<TShape[K]>;
} & {
  [K in OptionalKeys<TShape>]?: SchemaType<TShape[K]>;
} & (TPassthrough extends true ? Record<string, unknown> : Record<never, never>);

function object<TShape extends SchemaShape, TPassthrough extends boolean = false>(
  shape: TShape,
  options: { passthrough?: TPassthrough; } = {}
) {
  const passthrough = options.passthrough ?? false;
  return createSchema((value, path) => {
    if (!isPlainObject(value)) return fail(path, 'expected an object');
    const parsed: Record<string, unknown> = passthrough ? { ...value } : {};
    for (const [key, keySchema] of Object.entries(shape)) {
      const result = keySchema._parse(value[key], joinPath(path, key));
      if (!result.success) return result;
      if (result.data !== undefined || key in value) {
        parsed[key] = result.data;
      }
    }
    return ok(parsed as InferObject<TShape, TPassthrough>);
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
 */
function record<T>(valueSchema: Schema<T>) {
  return createSchema((value, path) => {
    if (!isPlainObject(value)) return fail(path, 'expected an object');
    const parsed: Record<string, T> = {};
    for (const [key, entry] of Object.entries(value)) {
      const result = valueSchema._parse(entry, joinPath(path, key));
      if (!result.success) return result;
      parsed[key] = result.data;
    }
    return ok(parsed);
  });
}

/** @param options */
function union<TOptions extends readonly Schema<unknown>[]>(options: TOptions): Schema<SchemaType<TOptions[number]>> {
  return createSchema<SchemaType<TOptions[number]>>((value, path) => {
    for (const option of options) {
      const result = option._parse(value, path);
      if (result.success) return result as ParseSuccess<SchemaType<TOptions[number]>>;
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

export { s, isPlainObject };
