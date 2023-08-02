const { expect, Broker, sinon, wait } = require('./helpers')

const Mixin = require('../lib/dim')

describe('Healthcheck', () => {
  const configurations = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }]

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

    return broker.waitForServices(['service'], 1000, 100)
  })

  after(() => {
    refreshLeaderLockCronStub.restore()
    healthcheckCronStub.restore()
    leaderHealthcheckCronStub.restore()

    return broker.stop()
  })

  afterEach(() => broker.cacher.clean())

  describe('when node has instances', () => {
    let healthcheckStub

    before(() => {
      healthcheckStub = sinon.stub(service, 'healthcheckInstance').callThrough()
    })

    after(() => healthcheckStub.restore())

    describe('when healthcheckInstance method is defined', () => {
      it('performs healthcheck on all instances', async () => {
        await wait(500)
        await service.healthcheck()

        expect(healthcheckStub.callCount).to.eql(configurations.length)

        for (let i = 0; i < configurations.length; i++) {
          expect(healthcheckStub).to.have.been.calledWith(configurations[i])
        }
      })

      describe('when healthcheck for instance fails', () => {
        let disconnectStub

        before(() => {
          healthcheckStub.withArgs(configurations[0]).rejects(new Error('Something went wrong'))
          disconnectStub = sinon.stub(service, 'disconnectInstance').callThrough()

          return wait(500)
        })

        after(() => {
          healthcheckStub.reset()
          disconnectStub.restore()
        })

        afterEach(() => service.rebalanceSelf(configurations))

        describe('when disconnectInstance method is defined', () => {
          it('attempts to disconnect the instance', async () => {
            await service.healthcheck()

            expect(disconnectStub).to.have.been.calledWith(configurations[0])
          })
        })

        describe('when disconnectInstance method is not defined', () => {
          it('does not attempt to disconnect the instance', async () => {
            disconnectStub.value(undefined)
            await service.healthcheck()
            disconnectStub.reset()

            expect(disconnectStub).not.to.have.been.called()
          })
        })

        it('removes the instance from the list of managed instances on node', async () => {
          const rebalanceSelfStub = sinon.stub(service, 'rebalanceSelf').resolves()
          await service.healthcheck()
          rebalanceSelfStub.restore()

          expect(Object.values(service.dim.instances)).to.eql(configurations.slice(1))
        })

        it('rebalances instances on itself', async () => {
          await service.healthcheck()

          expect(Object.values(service.dim.instances)).to.have.all.members(configurations)
        })
      })
    })

    describe('when healthcheckInstance method is not defined', () => {
      it('does not attempt to perform healthchecks', async () => {
        await wait(500)

        healthcheckStub.value(undefined)
        await service.healthcheck()
        healthcheckStub.reset()

        expect(healthcheckStub).not.to.have.been.called()
      })
    })
  })

  describe('when node has no instances', () => {
    let healthcheckStub
    let instancesStub

    before(() => {
      healthcheckStub = sinon.stub(service, 'healthcheckInstance').resolves()
      instancesStub = sinon.stub(service.dim, 'instances').value([])
    })

    after(() => {
      healthcheckStub.restore()
      instancesStub.restore()
    })

    it('does not perform any healthchecks', async () => {
      await service.healthcheck()

      expect(healthcheckStub).not.to.have.been.called()
    })
  })
})
