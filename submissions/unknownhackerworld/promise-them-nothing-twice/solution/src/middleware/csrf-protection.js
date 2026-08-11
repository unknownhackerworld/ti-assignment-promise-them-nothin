const Csrf = require('csrf');

const tokens = new Csrf();

// Safe HTTP methods that never mutate state - CSRF is not applicable to these.
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Issue a CSRF secret + signed token pair.
 * Callers (API clients or integration tests) that need to make state-changing
 * requests (POST/PUT/PATCH/DELETE) must:
 *   1. GET /csrf-token  -> receive { secret, token }
 *   2. Send X-CSRF-Secret and X-CSRF-Token headers on every mutating request.
 *
 * Why custom headers instead of cookies:
 *   This is a machine-to-machine API authenticated by X-Customer-Id (injected
 *   by the API gateway). Browsers enforce the Same-Origin Policy on custom
 *   request headers, so a forged cross-origin request cannot set these headers.
 *   That property provides equivalent protection to the double-submit cookie
 *   pattern without requiring any cookie infrastructure.
 */
function csrfTokenHandler(req, res) {
  const secret = tokens.secretSync();
  const token = tokens.create(secret);
  res.json({ secret, token });
}

/**
 * Middleware that validates CSRF tokens on state-changing requests.
 * GET / HEAD / OPTIONS are safe by HTTP definition and are not checked.
 */
function csrfProtection(req, res, next) {
  if (SAFE_METHODS.has(req.method)) {
    return next();
  }

  const secret = req.headers['x-csrf-secret'];
  const token = req.headers['x-csrf-token'];

  if (!secret || !token) {
    return res.status(403).json({
      error: 'Forbidden',
      message: 'CSRF validation failed: X-CSRF-Secret and X-CSRF-Token headers are required for state-changing requests.'
    });
  }

  if (!tokens.verify(secret, token)) {
    return res.status(403).json({
      error: 'Forbidden',
      message: 'CSRF validation failed: token is invalid or expired.'
    });
  }

  next();
}

module.exports = { csrfProtection, csrfTokenHandler };
