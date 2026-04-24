const { randomUUID } = require('crypto');
const { runWithContext } = require('../config/requestContext');

function requestIdMiddleware(req, res, next) {
  const requestId = req.headers['x-request-id'] || randomUUID();
  req.id = requestId;
  res.setHeader('X-Request-ID', requestId);
  runWithContext({ requestId }, next);
}

module.exports = { requestIdMiddleware };
