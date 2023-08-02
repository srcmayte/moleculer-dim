const _ = require('lodash')
const { ServiceBroker } = require('moleculer')
const brokerConfig = require('../../moleculer.config')

async function create (config = {}) {
  config = _.merge(brokerConfig, config)

  const broker = new ServiceBroker(config)

  return broker
}

module.exports = { create }
