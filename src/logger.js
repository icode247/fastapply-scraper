const pino = require('pino');
const config = require('./config');

module.exports = pino({
  level: process.env.LOG_LEVEL || 'info',
  ...(config.NODE_ENV === 'development' && {
    transport: { target: 'pino/file', options: { destination: 1 } },
  }),
});
