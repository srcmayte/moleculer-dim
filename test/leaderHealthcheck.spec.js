const { expect, Broker, sinon, wait } = require('./helpers')

const Mixin = require('../lib/dim')

describe('Leader healthcheck', () => {
  const configurations = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }]

  const brokers = []
  const services = []
  const refreshLeaderLockCronStubs = []
  const healthcheckCronStubs = []
  const leaderHealthcheckCronStubs = []

  beforeEach(async () => {
    const brokerPromises = []

    for (let i = 0; i < 2; i++) {
      brokerPromises.push(Broker.create({ nodeID: `node${i}`, logger: false }))
    }

    brokers.length = 0

    brokers.push(...await Promise.all(brokerPromises))

    services.length = 0
    refreshLeaderLockCronStubs.length = 0
    healthcheckCronStubs.length = 0
    leaderHealthcheckCronStubs.length = 0

    for (let i = 0; i < brokers.length; i++) {
      services.push(
        brokers[i].createService({
          name: 'service',
          mixins: [Mixin],
          methods: {
            getConfig: () => configurations,
            createInstance: config => config,
            healthcheckInstance: () => {},
            disconnectInstance: () => {}
          }
        })
      )

      // Disable crons
      refreshLeaderLockCronStubs.push(sinon.stub(services[i], 'createRefreshLeaderLockCron').returns())
      healthcheckCronStubs.push(sinon.stub(services[i], 'createHealthcheckCron').returns())
      leaderHealthcheckCronStubs.push(sinon.stub(services[i], 'createLeaderHealthcheckCron').returns())
    }

    await Promise.all(brokers.map(broker => broker.start()))

    brokers[0].cacher.set('service.leader', brokers[0].nodeID, services[0].settings.dim.leaderLockTTL)

    return Promise.all(services.map(service => service.waitForServices(['service'], 1000, 100))).then(() => wait(1100))
  })

  afterEach(async () => {
    refreshLeaderLockCronStubs.forEach(stub => stub.restore())
    healthcheckCronStubs.forEach(stub => stub.restore())
    leaderHealthcheckCronStubs.forEach(stub => stub.restore())

    await brokers[0].cacher.clean()

    return Promise.all(brokers.map(broker => broker.stop()))
  })

  describe('when there is no leader', () => {
    beforeEach(async () => {
      for (let i = 0; i < services.length; i++) {
        services[i].dim = { configurations: [], instances: {} }
      }

      return brokers[0].cacher.del('service.leader')
    })

    it('attempts to acquire leader lock', async () => {
      const acquireLeaderLockStub = sinon.stub(services[0], 'attemptAcquiringLeadership').resolves(true)

      await services[0].leaderHealthcheck()

      expect(acquireLeaderLockStub).to.have.been.calledOnce()

      acquireLeaderLockStub.restore()
    })

    describe('and node becomes leader', () => {
      it('rebalances instances across all nodes', async () => {
        for (let i = 0; i < services.length; i++) {
          expect(services[i].dim.configurations).to.eql([])
          expect(services[i].dim.instances).to.eql({})
        }

        await services[0].leaderHealthcheck()

        expect(services[0].dim.configurations).to.eql(configurations.slice(0, 3))
        expect(Object.values(services[0].dim.instances)).to.eql(configurations.slice(0, 3))
        expect(services[1].dim.configurations).to.eql(configurations.slice(3, 5))
        expect(Object.values(services[1].dim.instances)).to.eql(configurations.slice(3, 5))
      })
    })

    describe('and node does not become leader', () => {
      let acquireLeaderLockStub
      let rebalanceStub

      beforeEach(() => {
        acquireLeaderLockStub = sinon.stub(services[0], 'attemptAcquiringLeadership').resolves(false)
        rebalanceStub = sinon.stub(services[0], 'rebalance').resolves()
      })

      afterEach(() => {
        acquireLeaderLockStub.restore()
        rebalanceStub.restore()
      })

      it('does nothing', async () => {
        await services[0].leaderHealthcheck()

        expect(rebalanceStub).to.not.have.been.called()
      })
    })
  })

  describe('when there is already a leader', () => {
    describe('and node is not the leader', () => {
      beforeEach(() => brokers[0].cacher.set('service.leader', brokers[0].nodeID, services[0].settings.dim.leaderLockTTL))

      it('pings the current leader node', async () => {
        const pingStub = sinon.stub(brokers[1], 'ping').callThrough()

        await services[1].leaderHealthcheck()

        expect(pingStub).to.have.been.calledOnce()

        pingStub.restore()
      })

      describe('and there is a response from the leader', () => {
        it('does nothing', async () => {
          const acquireLeaderLockStub = sinon.stub(services[0], 'attemptAcquiringLeadership').callThrough()

          await services[1].leaderHealthcheck()

          expect(acquireLeaderLockStub).not.to.have.been.called()
        })
      })

      describe('when there is no response from the leader', () => {
        let pingStub

        beforeEach(() => {
          pingStub = sinon.stub(brokers[1], 'ping').resolves(null)
        })

        afterEach(() => pingStub.restore())

        it('deletes the leader lock', async () => {
          const cacheStub = sinon.stub(brokers[1].cacher, 'del').callThrough()

          await services[1].leaderHealthcheck()

          expect(cacheStub).to.have.been.calledWith('service.leader')
        })

        it('attempts to acquire leader lock', async () => {
          const acquireLeaderLockStub = sinon.stub(services[1], 'attemptAcquiringLeadership').callThrough()

          await services[1].leaderHealthcheck()

          expect(acquireLeaderLockStub).to.have.been.called()
        })

        describe('and node becomes leader', () => {
          beforeEach(() => {
            for (let i = 0; i < services.length; i++) {
              services[i].dim = { configurations: [], instances: {} }
            }

            return brokers[0].cacher.del('service.leader')
          })

          it('rebalances instances across all nodes', async () => {
            for (let i = 0; i < services.length; i++) {
              expect(services[i].dim.configurations).to.eql([])
              expect(services[i].dim.instances).to.eql({})
            }

            await services[1].leaderHealthcheck()

            const leader = await brokers[0].cacher.get('service.leader')

            expect(leader).to.eql(brokers[1].nodeID)
            expect(services[1].dim.configurations).to.eql(configurations.slice(0, 3))
            expect(Object.values(services[1].dim.instances)).to.eql(configurations.slice(0, 3))
            expect(services[0].dim.configurations).to.eql(configurations.slice(3, 5))
            expect(Object.values(services[0].dim.instances)).to.eql(configurations.slice(3, 5))
          })
        })

        describe('and node does not become the leader', () => {
          let acquireLeaderLockStub
          let rebalanceStub

          beforeEach(() => {
            acquireLeaderLockStub = sinon.stub(services[1], 'attemptAcquiringLeadership').resolves(false)
            rebalanceStub = sinon.stub(services[1], 'rebalance').callThrough()
          })

          afterEach(() => acquireLeaderLockStub.restore())

          it('does nothing', async () => {
            await services[1].leaderHealthcheck()

            expect(rebalanceStub).not.to.have.been.called()
          })
        })
      })
    })

    describe('and node is the leader', () => {
      let pingStub
      let acquireLeaderLockStub

      beforeEach(() => {
        pingStub = sinon.stub(brokers[0], 'ping').callThrough()
        acquireLeaderLockStub = sinon.stub(services[1], 'attemptAcquiringLeadership').callThrough()

        return brokers[0].cacher.set('service.leader', brokers[1].nodeID, services[0].settings.dim.leaderLockTTL)
      })

      afterEach(() => {
        pingStub.restore()
        acquireLeaderLockStub.restore()
      })

      it('does nothing', async () => {
        await services[1].leaderHealthcheck()

        expect(pingStub).not.to.have.been.called()
        expect(acquireLeaderLockStub).not.to.have.been.called()
      })
    })
  })
})
