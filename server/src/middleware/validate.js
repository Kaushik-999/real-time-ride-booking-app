'use strict';

const { badRequest } = require('../utils/errors');

/**
 * Validate req.body / req.params / req.query against Zod schemas.
 * Parsed (and stripped/coerced) values replace the originals, so handlers
 * only ever see validated data. Unknown body keys are rejected by the
 * `.strict()` schemas defined in validators.js.
 */
function validate({ body, params, query } = {}) {
  return (req, _res, next) => {
    const issues = [];
    const run = (schema, key) => {
      if (!schema) return;
      const result = schema.safeParse(req[key] ?? {});
      if (result.success) {
        if (key === 'query') {
          // req.query is a getter in Express 5; assign defensively.
          Object.defineProperty(req, 'query', { value: result.data, writable: true, configurable: true });
        } else {
          req[key] = result.data;
        }
      } else {
        for (const i of result.error.issues) {
          issues.push({ location: key, path: i.path.join('.'), message: i.message });
        }
      }
    };
    run(params, 'params');
    run(query, 'query');
    run(body, 'body');
    if (issues.length) return next(badRequest('Request validation failed', issues));
    next();
  };
}

module.exports = { validate };
