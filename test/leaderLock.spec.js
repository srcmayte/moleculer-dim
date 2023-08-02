const { expect, Broker, sinon, wait } = require('./helpers')

const Mixin = require('../lib/dim')

describe('Leader lock', () => {
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

  describe('when no lock exist', () => {
    beforeEach(async () => {
      await wait(100)

      return broker.cacher.del('service.leader')
    })

    it('sets leader to itself', async () => {
      const originalLeader = await broker.cacher.get('service.leader')

      expect(originalLeader).to.eql(null)

      await service.attemptAcquiringLeadership()

      const leader = await broker.cacher.get('service.leader')

      expect(leader).to.eql(broker.nodeID)
    })

    it('returns true', async () => {
      const result = await service.attemptAcquiringLeadership()

      expect(result).to.eql(true)
    })
  })

  describe('when lock exists', () => {
    it('returns false', async () => {
      const release = await broker.cacher.tryLock('service.leader', service.settings.dim.leaderLockTTL * 1000)
      const result = await service.attemptAcquiringLeadership()
      await release()

      expect(result).to.eql(false)
    })
  })

  describe('when locking throws an error', () => {
    let lockStub

    before(() => {
      lockStub = sinon.stub(broker.cacher, 'tryLock').throws(new Error('Lock error'))
    })

    after(() => lockStub.restore())

    it('throws the error', async () => {
      let thrownError = null

      try {
        await service.attemptAcquiringLeadership()
      } catch (error) {
        thrownError = error
      }

      expect(thrownError.message).to.eql('Lock error')
    })
  })
})
