const { expect, Broker, sinon, wait } = require('./helpers')

const Mixin = require('../lib/dim')

describe('Events', () => {
  const configurations = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }]

  let broker
  let service
  let refreshLeaderLockCronStub
  let healthcheckCronStub
  let leaderHealthcheckCronStub

  before(async () => {
    broker = await Broker.create({ nodeID: 'node0', logger: false })

    service = broker.createService({
      name: 'service',
      mixins: [Mixin],
      methods: {
        getConfig: () => configurations,
        createInstance: config => config,
        healthcheckInstance: () => {},
        disconnectInstance: () => {}
      }
    })

    // Disable crons
    refreshLeaderLockCronStub = sinon.stub(service, 'createRefreshLeaderLockCron').returns()
    healthcheckCronStub = sinon.stub(service, 'createHealthcheckCron').returns()
    leaderHealthcheckCronStub = sinon.stub(service, 'createLeaderHealthcheckCron').returns()

    await broker.start()

    await broker.cacher.set('service.leader', broker.nodeID, service.settings.dim.leaderLockTTL)

    return broker.waitForServices(['service'], 1000, 100)
  })

  after(() => {
    refreshLeaderLockCronStub.restore()
    healthcheckCronStub.restore()
    leaderHealthcheckCronStub.restore()

    return broker.stop()
  })

  afterEach(() => broker.cacher.clean())

  describe('when a node connects', () => {
    let otherBroker
    let otherService
    let otherRefreshLeaderLockCronStub
    let otherHealthcheckCronStub
    let otherLeaderHealthcheckCronStub

    before(async () => {
      otherBroker = await Broker.create({ nodeID: 'node1', logger: false })

      otherService = otherBroker.createService({
        name: 'service',
        mixins: [Mixin],
        methods: {
          getConfig: () => configurations,
          createInstance: config => config,
          healthcheckInstance: () => {},
          disconnectInstance: () => {}
        }
      })

      // Disable crons
      otherRefreshLeaderLockCronStub = sinon.stub(otherService, 'createRefreshLeaderLockCron').returns()
      otherHealthcheckCronStub = sinon.stub(otherService, 'createHealthcheckCron').returns()
      otherLeaderHealthcheckCronStub = sinon.stub(otherService, 'createLeaderHealthcheckCron').returns()

      await otherBroker.start()
      await otherBroker.waitForServices(['service'], 1000, 100)

      return wait(1200)
    })

    after(() => {
      otherRefreshLeaderLockCronStub.restore()
      otherHealthcheckCronStub.restore()
      otherLeaderHealthcheckCronStub.restore()

      return otherBroker.stop()
    })

    it('rebalances instances across all available nodes', async () => {
      expect(service.dim.configurations).to.eql(configurations.slice(0, 3))
      expect(Object.values(service.dim.instances)).to.eql(configurations.slice(0, 3))
      expect(otherService.dim.configurations).to.eql(configurations.slice(3, 5))
      expect(Object.values(otherService.dim.instances)).to.eql(configurations.slice(3, 5))
    })
  })

  describe('when a node disconnects', () => {
    let otherBroker
    let otherService
    let otherRefreshLeaderLockCronStub
    let otherHealthcheckCronStub
    let otherLeaderHealthcheckCronStub

    beforeEach(async () => {
      otherBroker = await Broker.create({ nodeID: 'node1', logger: false })

      otherService = otherBroker.createService({
        name: 'service',
        mixins: [Mixin],
        methods: {
          getConfig: () => configurations,
          createInstance: config => config,
          healthcheckInstance: () => {},
          disconnectInstance: () => {}
        }
      })

      // Disable crons
      otherRefreshLeaderLockCronStub = sinon.stub(otherService, 'createRefreshLeaderLockCron').returns()
      otherHealthcheckCronStub = sinon.stub(otherService, 'createHealthcheckCron').returns()
      otherLeaderHealthcheckCronStub = sinon.stub(otherService, 'createLeaderHealthcheckCron').returns()

      await otherBroker.start()
      await otherBroker.waitForServices(['service'], 1000, 100)

      return wait(1200)
    })

    afterEach(() => {
      otherRefreshLeaderLockCronStub.restore()
      otherHealthcheckCronStub.restore()
      otherLeaderHealthcheckCronStub.restore()

      if (otherBroker.connected) {
        return otherBroker.stop()
      }
    })

    describe('and disconnected node was the leader', () => {
      it('removes existing leader lock', async () => {
        const acquireLeaderLockStub = sinon.stub(service, 'attemptAcquiringLeadership').resolves()

        await broker.cacher.set('service.leader', otherBroker.nodeID, service.settings.dim.leaderLockTTL)
        await otherBroker.stop()
        await wait(100)

        const leader = await broker.cacher.get('service.leader')

        expect(leader).to.eql(null)

        acquireLeaderLockStub.restore()
      })

      it('attempts to acquire leader lock', async () => {
        await otherBroker.stop()
        await wait(100)

        const leader = await broker.cacher.get('service.leader')

        expect(leader).to.eql(broker.nodeID)
      })
    })

    describe('and node is the leader', () => {
      it('rebalances instances across remaining nodes', async () => {
        await otherBroker.stop()
        await wait(100)

        expect(service.dim.configurations).to.eql(configurations)
        expect(Object.values(service.dim.instances)).to.eql(configurations)
      })
    })
  })
})
