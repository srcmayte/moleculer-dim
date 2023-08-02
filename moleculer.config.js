const { v4: uuid } = require('uuid')

module.exports = {
  namespace: 'test',
  nodeID: `node-${uuid().split('-')[0]}`,
  transporter: 'fake',
  logLevel: 'debug',
  hotReload: process.env.NODE_ENV !== 'test' && process.env.HOT_RELOAD === 'true',
  cacher: {
    type: 'Redis',
    options: { redis: {} }
  }
}
