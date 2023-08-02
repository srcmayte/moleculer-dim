const _ = require('lodash')
const crypto = require('crypto')
const cron = require('cron')
const { ServiceSchemaError } = require('moleculer').Errors
const CronMixin = require('@r2d2bzh/moleculer-cron')

module.exports = {
  name: 'moleculer-dim',
  mixins: [CronMixin],
  settings: {
    dim: {
      refreshLeaderLockCronTime: '*/15 * * * * *',
      healthcheckCronTime: '*/10 * * * * *',
      leaderHealthcheckCronTime: '*/5 * * * * *',
      leaderLockTTL: 30
    }
  },

  methods: {
    getConfig: function () {
      throw new ServiceSchemaError('getConfig not defined as a method')
    },

    createInstance: function () {
      throw new ServiceSchemaError('createInstance not defined as a method')
    },

    encodedConfigId: function (config) {
      return crypto.createHash('md5').update(JSON.stringify(config)).digest('hex')
    },

    createCron: function (name, cronTime, onTick) {
      const cronConf = { cronTime, onTick, start: true, context: this }
      const job = new cron.CronJob(cronConf)

      job.name = name

      this.$crons.push(job)
    },

    createRefreshLeaderLockCron: function () {
      this.createCron('refreshLock', this.settings.dim.refreshLeaderLockCronTime, function () {
        return this.refreshLeaderLock()
      })
    },

    createHealthcheckCron: function () {
      this.createCron('healthcheck', this.settings.dim.healthcheckCronTime, function () {
        return this.healthcheck()
      })
    },

    createLeaderHealthcheckCron: function () {
      this.createCron('leaderCheck', this.settings.dim.leaderHealthcheckCronTime, function () {
        return this.leaderHealthcheck()
      })
    },

    getLeaderKey: function () {
      return `${this.name}.leader`
    },

    getLeader: async function () {
      return this.broker.cacher.get(this.getLeaderKey())
    },

    setLeader: async function () {
      return this.broker.cacher.set(this.getLeaderKey(), this.broker.nodeID, this.settings.dim.leaderLockTTL)
    },

    isLeader: function (leader) {
      return this.broker.nodeID === leader
    },

    getServiceNodes: async function (name) {
      const service = await this.broker.call('$node.services').then(list => {
        return list.find(service => service.fullName === name)
      })

      return service?.nodes || []
    },

    findConfig: function (configurations, id) {
      return configurations.find(conf => this.encodedConfigId(conf) === id)
    },

    refreshLeaderLock: async function () {
      this.logger.debug(`Refreshing lock for ${this.getLeaderKey()}`)

      try {
        const leader = await this.getLeader()
        const isLeader = this.isLeader(leader)

        if (!leader) {
          this.logger.debug(`There is no leader for ${this.getLeaderKey()}`)

          await this.attemptAcquiringLeadership()
        } else if (isLeader) {
          await this.setLeader()

          this.logger.debug(`Refreshed lock for ${this.getLeaderKey()}`)
        }
      } catch (err) {
        this.logger.error(`Error updating lock for ${this.getLeaderKey()}: ${err.message}`)
        this.logger.error(err)

        throw err
      }
    },

    healthcheck: function () {
      this.logger.debug('Performing healthcheck for instances')

      const promises = []

      for (const id of Object.keys(this.dim.instances)) {
        promises.push(
          (async () => {
            if (!this.healthcheckInstance) {
              return
            }

            try {
              await this.healthcheckInstance(this.dim.instances[id])
              this.logger.debug(`Healthcheck passed for instance ${id}`)
            } catch (err) {
              this.logger.warn(`Healthcheck failed for instance ${id}: ${err.message}`)
              this.logger.warn(err)

              if (this.disconnectInstance) {
                try {
                  await this.disconnectInstance(this.dim.instances[id])
                } catch (disconnectErr) {
                  this.logger.error(`Error disconnecting instance ${id}: ${disconnectErr.message}`)
                  this.logger.error(disconnectErr)
                }
              }

              delete this.dim.instances[id]

              return this.rebalanceSelf(this.dim.configurations)
            }
          })()
        )
      }

      return Promise.all(promises)
    },

    leaderHealthcheck: async function () {
      const leader = await this.getLeader()

      let acquireLeadership = false

      if (leader && !this.isLeader(leader)) {
        const response = await this.broker.ping(leader, 1000)

        if (!response) {
          this.logger.warn(`Leader ${leader} is not responding, removing leader lock`)

          await this.broker.cacher.del(this.getLeaderKey())
          acquireLeadership = true
        }
      } else if (!leader) {
        acquireLeadership = true
      }

      if (acquireLeadership) {
        const acquired = await this.attemptAcquiringLeadership()

        if (acquired) {
          return this.rebalance()
        }
      }
    },

    attemptAcquiringLeadership: async function () {
      this.logger.info(`Attempting to acquire leadership for ${this.getLeaderKey()}`)

      try {
        const release = await this.broker.cacher.tryLock(this.getLeaderKey(), this.settings.dim.leaderLockTTL * 1000)
        await this.setLeader()
        await release()

        this.logger.info(`Leadership acquired for ${this.getLeaderKey()}, acting as leader`)

        return true
      } catch (err) {
        if (err.name === 'LockError') {
          this.logger.info(`Leadership already acquired for ${this.getLeaderKey()}, acting as slave`)

          return false
        } else {
          throw err
        }
      }
    },

    rebalanceSelf: async function (configurations = []) {
      this.logger.debug(`Rebalancing self with ${configurations.length} configurations`)
      const instanceIds = Object.keys(this.dim.instances)
      const configIds = configurations.map(conf => this.encodedConfigId(conf))
      const addIds = _.differenceWith(configIds, instanceIds, _.isEqual)
      const removeIds = _.differenceWith(instanceIds, configIds, _.isEqual)

      this.dim.configurations = configurations

      this.logger.debug(`${addIds.length} instances to create`)
      this.logger.debug(`${removeIds.length} instances to remove`)

      if (addIds.length > 0) {
        const addPromises = []

        addIds.forEach(id => {
          const config = this.findConfig(configurations, id)

          addPromises.push(
            (async () => {
              const instance = await this.createInstance(config)

              this.logger.debug(`Created instance ${id}`)

              return instance
            })()
          )
        })

        const instances = await Promise.all(addPromises)

        for (let i = 0; i < addIds.length; i++) {
          this.dim.instances[addIds[i]] = instances[i]
        }
      }

      if (removeIds.length > 0) {
        const removePromises = []

        for (const id of removeIds) {
          removePromises.push(
            (async () => {
              if (this.disconnectInstance) {
                this.logger.debug(`Started disconnecting instance ${id}`)

                try {
                  await this.disconnectInstance(this.dim.instances[id])
                  this.logger.debug(`Disconnected instance ${id}`)
                } catch (err) {
                  this.logger.error(`Disconnection error for instance ${id}: ${err.message}`)
                  this.logger.error(err)
                }
              }

              delete this.dim.instances[id]
              this.logger.debug(`Removed instance ${id}`)
            })()
          )
        }

        await Promise.all(removePromises)
      }
    },

    rebalanceNode: async function (nodeId, configurations = {}) {
      this.logger.debug(`Rebalancing instances for node ${nodeId}`)

      const name = `${this.fullName}.rebalance`

      return this.broker.call(name, { configurations }, { nodeID: nodeId })
    },

    rebalance: async function () {
      const nodes = await this.getServiceNodes(this.fullName)
      const config = await this.getConfig() || []
      const maxPerNode = `${Math.ceil(config.length / nodes.length)}`
      const batches = _.chunk(config, maxPerNode)

      if (nodes.length > 0) {
        this.logger.debug(`Rebalancing ${config.length} configurations across ${nodes.length} instances, ${maxPerNode} per node`)

        for (let i = 0; i < batches.length; i++) {
          await this.rebalanceNode(nodes[i], batches[i])
        }

        this.logger.debug('Rebalancing complete')
      } else {
        this.logger.debug('No nodes to rebalance across')
      }
    },

    rebalanceIfLeader: async function () {
      let leader = await this.getLeader()

      if (!leader) {
        await this.attemptAcquiringLeadership()
        leader = await this.getLeader()
      }

      if (this.isLeader(leader)) {
        return this.rebalance()
      }
    }
  },

  events: {
    '$services.changed': {
      handler: async function (ctx) {
        if (ctx.service.fullName !== this.fullName) {
          return
        }

        return this.rebalanceIfLeader()
      }
    },

    '$node.connected': async function (ctx) {
      return this.rebalanceIfLeader()
    },

    '$node.disconnected': async function (ctx) {
      const leader = await this.getLeader()

      if (ctx.params.node.id === leader) {
        this.logger.warn(`Leader ${ctx.params.node.id} disconnected, removing leader lock and attempting to acquire leadership`)
        await this.broker.cacher.del(this.getLeaderKey())
        await this.attemptAcquiringLeadership()
      }

      if (this.broker.started) {
        return this.rebalanceIfLeader()
      }
    }
  },

  async started () {
    this.dim = { configurations: [], instances: {} }

    await Promise.all([
      this.createRefreshLeaderLockCron(),
      this.createHealthcheckCron(),
      this.createLeaderHealthcheckCron()
    ])
  },

  async stopped () {
    if (this.disconnectInstance) {
      const promises = []

      for (const key in this.dim.instances) {
        promises.push(this.disconnectInstance(this.dim.instances[key]))
      }

      await Promise.all(promises)
    }

    this.dim = { configurations: [], instances: {} }
  },

  actions: {
    rebalance: {
      params: {
        configurations: { type: 'array', required: true }
      },
      handler: async function (ctx) {
        return this.rebalanceSelf(ctx.params.configurations)
      }
    }
  }
}
