const Csrf = require('csrf');

const tokens = new Csrf();

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// Cookie that stores the server-side CSRF secret.
// httpOnly prevents JS from reading it; the token in the header
// proves the client received a valid /csrf-token response.
const CSRF_COOKIE = '_csrf_secret';

/**
 * Issue a CSRF token.
 *
 * The secret is stored in an httpOnly cookie so it never travels in a
 * readable response body. Only the signed token is returned to the caller.
 * Clients that need to make state-changing requests must:
 *   1. GET /csrf-token → receive { token } and a Set-Cookie: _csrf_secret=...
 *   2. Send X-CSRF-Token header on every POST / PUT / PATCH / DELETE.
 *
 * Why custom header + cookie (double-submit pattern):
 *   Browsers enforce the Same-Origin Policy on both custom request headers and
 *   httpOnly cookies. A forged cross-origin request cannot read the cookie or
 *   set the X-CSRF-Token header, so it cannot pass validation.
 */
function csrfTokenHandler(req, res) {
  const secret = tokens.secretSync();
  const token = tokens.create(secret);

  res.cookie(CSRF_COOKIE, secret, {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
  });

  res.json({ token });
}

/**
 * Validate CSRF tokens on state-changing requests.
 * GET / HEAD / OPTIONS are safe by HTTP definition and are not checked.
 *
 * Requires cookie-parser to be mounted before this middleware.
 */
function csrfProtection(req, res, next) {
  if (SAFE_METHODS.has(req.method)) {
    return next();
  }

  const secret = req.cookies && req.cookies[CSRF_COOKIE];
  const token = req.headers['x-csrf-token'];

  if (!secret || !token) {
    return res.status(403).json({
      error: 'Forbidden',
      message: 'CSRF validation failed: a valid CSRF cookie and X-CSRF-Token header are required for state-changing requests.',
    });
  }

  if (!tokens.verify(secret, token)) {
    return res.status(403).json({
      error: 'Forbidden',
      message: 'CSRF validation failed: token is invalid or expired.',
    });
  }

  next();
}

module.exports = { csrfProtection, csrfTokenHandler };
