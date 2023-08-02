const { expect, Broker, sinon, wait } = require('./helpers')

const Mixin = require('../lib/dim')

describe('Refresh leader lock', () => {
  let broker
  let service
  let refreshLeaderLockCronStub
  let healthcheckCronStub
  let leaderHealthcheckCronStub

  before(async () => {
    broker = await Broker.create({ logger: false })

    service = broker.createService({
      name: 'service',
      mixins: [Mixin],
      methods: {
        getConfig: () => {},
        createInstance: () => {},
        healthcheckInstance: () => {},
        disconnectInstance: () => {}
      }
    })

    // Disable crons
    refreshLeaderLockCronStub = sinon.stub(service, 'createRefreshLeaderLockCron').returns()
    healthcheckCronStub = sinon.stub(service, 'createHealthcheckCron').returns()
    leaderHealthcheckCronStub = sinon.stub(service, 'createLeaderHealthcheckCron').returns()

    await broker.start()

    return broker.waitForServices(['service'], 1000, 100)
  })

  after(() => {
    refreshLeaderLockCronStub.restore()
    healthcheckCronStub.restore()
    leaderHealthcheckCronStub.restore()

    return broker.stop()
  })

  afterEach(() => broker.cacher.clean())

  describe('when there is no leader', () => {
    it('attempts to acquire leader lock', async () => {
      await broker.cacher.del('service.leader')
      await service.refreshLeaderLock()

      const lock = await broker.cacher.getWithTTL('service.leader')

      expect(lock.ttl).to.eql(30)
    })
  })

  describe('when node is not the leader', () => {
    const otherNodeId = 'node-different'

    before(() => broker.cacher.set('service.leader', otherNodeId, service.settings.dim.leaderLockTTL))

    it('does nothing', async () => {
      await service.refreshLeaderLock()

      const lock = await broker.cacher.get('service.leader')

      expect(lock).to.eql(otherNodeId)
    })
  })

  describe('when node is the leader', () => {
    before(() => broker.cacher.set('service.leader', broker.nodeID, service.settings.dim.leaderLockTTL))

    it('updates leader lock', async () => {
      await wait(1000) // Wait for cron TTL to decrease

      const initialLock = await broker.cacher.getWithTTL('service.leader')

      expect(initialLock.data).to.eql(broker.nodeID)
      expect(initialLock.ttl).to.be.below(30)

      await service.refreshLeaderLock()

      const lock = await broker.cacher.getWithTTL('service.leader')

      expect(lock.data).to.eql(broker.nodeID)
      expect(lock.ttl).to.eql(30)
    })

    describe('and there is an error refreshing the leader lock', () => {
      let getLeaderStub

      before(() => {
        getLeaderStub = sinon.stub(service, 'getLeader').rejects(new Error('Something went wrong'))
      })

      after(() => getLeaderStub.restore())

      it('throws an error', async () => {
        let thrownError = null

        try {
          await service.refreshLeaderLock()
        } catch (error) {
          thrownError = error
        }

        expect(thrownError.message).to.eql('Something went wrong')
      })
    })
  })
})
