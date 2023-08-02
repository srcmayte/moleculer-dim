const chai = require('chai')
const sinon = require('sinon')
const chance = require('chance')()

const Broker = require('./broker')

const expect = chai.expect

chai.use(require('dirty-chai'))
chai.use(require('sinon-chai'))

function wait (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

module.exports = {
  expect,
  Broker,
  sinon,
  chance,
  wait
}
