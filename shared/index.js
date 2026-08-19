// @ts-check
'use strict';

/**
 * `@wetalk/shared` — the wire contracts shared by `mobile/` and `server/`.
 * See `shared/README.md`.
 */

const { s, isPlainObject } = require('./schema');
const events = require('./signaling/events');
const schemas = require('./signaling/schemas');
const api = require('./api/routes');

module.exports = {
  s,
  isPlainObject,
  ...events,
  ...schemas,
  ...api,
};
