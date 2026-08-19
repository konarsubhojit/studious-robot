'use strict';

const { s } = require('../schema');

/**
 * REST surface shared by the mobile client and the server.
 *
 * Paths live here so a route rename is a single edit (the Express routers and
 * the client `fetch` calls both read from `API_ROUTES`), and the response
 * schemas let the client reject a malformed body at the edge instead of
 * propagating `undefined` into the UI.
 */

const API_ROUTES = Object.freeze({
  HEALTH: '/health',
  METRICS: '/metrics',
  SESSION: '/session',
  SESSION_REFRESH: '/session/refresh',
  USERS: '/users',
  DEVICES_REGISTER: '/devices/register',
  DEVICES_UNREGISTER: '/devices/unregister',
  DEVICES_PUSH_RECEIPT: '/devices/push-receipt',
  CONVERSATIONS: '/conversations',
  MESSAGES: '/messages',
  MESSAGES_READ: '/messages/read',
  CALLS: '/calls',
  TURN_CREDENTIALS: '/turn-credentials',
});

/** `GET /health` */
const HEALTH_RESPONSE = s.object(
  {
    status: s.enum(['ok', 'draining']),
    service: s.string({ min: 1 }),
    uptime: s.number({ min: 0 }),
    timestamp: s.string({ min: 1 }),
  },
  { passthrough: true }
);

/** `POST /session` and `POST /session/refresh` */
const SESSION_RESPONSE = s.object(
  {
    sessionId: s.id(),
    userId: s.id(),
  },
  { passthrough: true }
);

/** `GET /users?query=…` */
const USER_SEARCH_RESPONSE = s.object(
  {
    users: s.array(s.object({ userId: s.id() }, { passthrough: true })),
  },
  { passthrough: true }
);

module.exports = {
  API_ROUTES,
  HEALTH_RESPONSE,
  SESSION_RESPONSE,
  USER_SEARCH_RESPONSE,
};
