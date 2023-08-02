const { expect, Broker, sinon, wait } = require('./helpers')

const Mixin = require('../lib/dim')

describe('DIM', () => {
  let broker

  before(async () => {
    broker = await Broker.create({ logger: false })

    return broker.start()
  })

  after(() => broker.stop())

  afterEach(() => broker.cacher.clean())

  describe('settings', () => {
    describe('refreshLeaderLockCron', () => {
      // Defaults to */15 * * * * *
      it('defaults to sane cron time', () => {
        expect(Mixin.settings.dim.refreshLeaderLockCronTime).to.eql('*/15 * * * * *')
      })
    })

    describe('healthcheckCronTime', () => {
      // Defaults to */10 * * * * *
      it('defaults to sane cron time', () => {
        expect(Mixin.settings.dim.healthcheckCronTime).to.eql('*/10 * * * * *')
      })
    })

    describe('leaderHealthcheckCronTime', () => {
      // Defaults to */10 * * * * *
      it('defaults to sane cron time', () => {
        expect(Mixin.settings.dim.leaderHealthcheckCronTime).to.eql('*/5 * * * * *')
      })
    })

    describe('leaderLockTTL', () => {
      // Defaults to 30s
      it('defaults to sane TTL', () => {
        expect(Mixin.settings.dim.leaderLockTTL).to.eql(30)
      })
    })
  })

  describe('methods', () => {
    describe('getConfig', () => {
      it('throws a schema error unless defined', () => {
        let thrownError = null
        try {
          Mixin.methods.getConfig()
        } catch (err) {
          thrownError = err
        }

        expect(thrownError.type).to.eql('SERVICE_SCHEMA_ERROR')
      })
    })

    describe('createInstance', () => {
      it('throws a schema error unless defined', () => {
        let thrownError = null
        try {
          Mixin.methods.createInstance()
        } catch (err) {
          thrownError = err
        }

        expect(thrownError.type).to.eql('SERVICE_SCHEMA_ERROR')
      })
    })
  })

  describe('when service is started', () => {
    let service

    before(() => {
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

      return broker.waitForServices(['service'], 1000, 100)
    })

    after(() => broker.destroyService('service'))

    it('creates refresh leader lock cron job', () => {
      const cron = service.$crons.find(cron => cron.name === 'refreshLock')
      expect(cron).not.to.eql(undefined)
    })

    it('creates healthcheck cron job', () => {
      const cron = service.$crons.find(cron => cron.name === 'healthcheck')
      expect(cron).not.to.eql(undefined)
    })

    it('creates leader healthcheck cron job', () => {
      const cron = service.$crons.find(cron => cron.name === 'leaderCheck')
      expect(cron).not.to.eql(undefined)
    })
  })

  describe('when service is stopped', () => {
    const configurations = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }]

    let service
    let disconnectInstanceStub
    let refreshLeaderLockCronStub
    let healthcheckCronStub
    let leaderHealthcheckCronStub

    beforeEach(() => {
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

      disconnectInstanceStub = sinon.stub(service, 'disconnectInstance').resolves()

      // Disable crons, as not being tested
      refreshLeaderLockCronStub = sinon.stub(service, 'createRefreshLeaderLockCron').returns()
      healthcheckCronStub = sinon.stub(service, 'createHealthcheckCron').returns()
      leaderHealthcheckCronStub = sinon.stub(service, 'createLeaderHealthcheckCron').returns()

      return broker.waitForServices(['service'], 1000, 100).then(() => wait(200))
    })

    afterEach(() => {
      disconnectInstanceStub.restore()
      refreshLeaderLockCronStub.restore()
      healthcheckCronStub.restore()
      leaderHealthcheckCronStub.restore()
    })

    describe('when disconnectInstance method is defined', () => {
      it('attempts to disconnect all managed instances', async () => {
        await broker.destroyService('service')

        configurations.forEach(config => {
          expect(disconnectInstanceStub).to.have.been.calledWith(config)
        })
      })
    })

    describe('when disconnectInstance method is not defined', () => {
      it('does not attempt to disconnect all managed instances', async () => {
        disconnectInstanceStub.value(undefined)
        await broker.destroyService('service')
        disconnectInstanceStub.reset()

        expect(disconnectInstanceStub).not.to.have.been.called()
      })
    })

    it('resets DIM state', async () => {
      await broker.destroyService('service')

      expect(service.dim).to.eql({ configurations: [], instances: {} })
    })
  })

  describe('actions', () => {
    describe('rebalance', () => {
      const configurations = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }]
      const newConfigurations = [{ id: 6 }, { id: 7 }]

      let service
      let disconnectStub
      let refreshLeaderLockCronStub
      let healthcheckCronStub
      let leaderHealthcheckCronStub

      beforeEach(() => {
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

        disconnectStub = sinon.stub(service, 'disconnectInstance').callThrough()

        // Disable crons, as not being tested
        refreshLeaderLockCronStub = sinon.stub(service, 'createRefreshLeaderLockCron').returns()
        healthcheckCronStub = sinon.stub(service, 'createHealthcheckCron').returns()
        leaderHealthcheckCronStub = sinon.stub(service, 'createLeaderHealthcheckCron').returns()

        return broker.waitForServices(['service'], 1000, 100)
      })

      afterEach(() => {
        disconnectStub.restore()
        refreshLeaderLockCronStub.restore()
        healthcheckCronStub.restore()
        leaderHealthcheckCronStub.restore()

        return broker.destroyService('service')
      })

      it('rebalances itself based on provided config', async () => {
        expect(service.dim.configurations).to.eql(configurations)

        await broker.call('service.rebalance', { configurations: newConfigurations })

        expect(service.dim.configurations).to.eql(service.dim.configurations)
        expect(Object.values(service.dim.instances)).to.eql(newConfigurations)
      })

      describe('removing instances', () => {
        describe('when disconnectInstance method is defined', () => {
          it('attempts to disconnect instances that are no longer managed', async () => {
            await broker.call('service.rebalance', { configurations: newConfigurations })

            expect(disconnectStub).to.have.been.calledWith(configurations[0])
            expect(disconnectStub).to.have.been.calledWith(configurations[1])
            expect(disconnectStub).to.have.been.calledWith(configurations[2])
            expect(disconnectStub).to.have.been.calledWith(configurations[3])
            expect(disconnectStub).to.have.been.calledWith(configurations[4])
          })

          describe('when disconnecting instance throws an error', () => {
            beforeEach(() => disconnectStub.withArgs(configurations[0]).rejects(new Error('Something went wrong')))
            afterEach(() => disconnectStub.reset())

            it('does not throw an error', async () => {
              await broker.call('service.rebalance', { configurations: newConfigurations })

              expect(disconnectStub).to.have.been.calledWith(configurations[0])
            })
          })
        })

        describe('when disconnectInstance method is not defined', () => {
          beforeEach(() => disconnectStub.value(undefined))
          afterEach(() => disconnectStub.reset())

          it('does not attempt to disconnect instances that are no longer managed', async () => {
            await broker.call('service.rebalance', { configurations: newConfigurations })

            expect(disconnectStub).not.to.have.been.called()
          })
        })
      })
    })
  })
})
