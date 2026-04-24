const winston = require('winston');
const { getRequestContext } = require('./requestContext');

const isDev = process.env.NODE_ENV !== 'production';

const addRequestId = winston.format((info) => {
  const { requestId } = getRequestContext();
  if (requestId) info.request_id = requestId;
  return info;
});

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    addRequestId(),
    winston.format.timestamp(),
    isDev
      ? winston.format.combine(
          winston.format.colorize(),
          winston.format.printf(({ timestamp, level, message, request_id, ...meta }) => {
            const idStr = request_id ? ` [${String(request_id).slice(0, 8)}]` : '';
            const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
            return `${timestamp}${idStr} ${level}: ${message}${metaStr}`;
          })
        )
      : winston.format.json()
  ),
  transports: [new winston.transports.Console()],
});

module.exports = logger;
