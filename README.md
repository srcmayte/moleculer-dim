# Moleculer Distributed Instance Manager
A Moleculer JS mixin for managing distributed instances across broker nodes.

# Table of contents
- [Overview](#overview)
- [Architecture](#architecture)
- [Installation](#installation)
- [Usage](#usage)
- [Methods](#methods)
- [Settings](#settings)

# Overview
Moleculer allows you to scale services across multiple broker nodes, where each node's service is a replica of the derived service. Distributing configured instances evenly across available nodes with at most one instance per configuration is not possible natively in Moleculer.

This is where `moleculer-dim` comes in. It solves this problem by using Redis with a single elected leader node to distribute instances across all available nodes. The distributed instances could be workers, client connections like websockets, or any other type of instance you want spread evenly across nodes.

This prevents duplicate instances doing the same work, reduces race conditions, redundant workloads, and resource consumption.

**Note:** While `moleculer-dim` is being used in production, the API may change prior to a 1.0 release. Use at your own risk!

# Architecture
DIM has been designed with simplicity and DRY in mind, utilising existing features and functionality already available within the Moleculer ecosystem.

## Leadership acquirement
All nodes have a chance at becoming the leader when either no leader exists, or the existing leader becomes unhealthy. 

To prevent race conditions when multiple nodes attempt to acquire leadership at the same time, `redlock` is used. In addition, the leader key which is stored in Redis is refreshed periodically by the leader itself. If the key expires, a new leader is elected.

## Balancing and Rebalancing
Configured instances are evenly distributed across all available broker nodes for the derived service. Rebalacing of the configured instances occurs upon node connection and disconnection, as well as when the leader is considered unhealthy (not responding to PING).

Nodes balance their instances by adding new instances and removing no longer managed instances.

Whenever the leader performs a rebalance, each node records the configured instances it should maintain allowing for nodes to rebalance themselves. Nodes rebalance themselves when one or more of their instances are considered unhealthy.

## Health checks
Healthchecks (optional but recommended) are designed to signify to DIM when a configured instance is unhealthy. An instance is considered unhealthy when the configured healthcheck throws an error, any other response results in the instance being considered healthy.

When an instance becomes unhealthy the node running the instance will attempt to disconnect the instance (if configured) and will rebalance its own instances in attempt to reconnect any unhealthy instances.

Each node also healthchecks the leader. If the leader becomes unresponsive a healthy node will acquire leadership.

Instance and leader healthchecks are performed periodically and are configurable.

# Installation
No official NPM package will be released until version 1.0.0. For now, link to the git repo.

```bash
npm install --save git+ssh://github.com/srcmayte/moleculer-dim.git#main
```

# Usage
DIM requires only two methods to get started - `getConfig` and `createInstance`. You can also optionally define `healthcheckInstance` and `disconnectInstance`.

```javascript
const DIM = require('moleculer-dim')

module.exports = {
  name: 'example',
  mixins: [DIM],
  methods: {
    getConfig: () => [
      { id: 1 }, 
      { id: 2 },  
      { id: 3 },
      { id: 4 }
    ],

    createInstance: config => {
      return new Instance(config)
    }
  }
}
```

# Methods
```javascript
module.exports = {
  // ...

  methods: {
    getConfig: () => {},
    createInstance: config => {},
    healthcheckInstance: instance => {}, 
    disconnectInstance: instance => {}
  }

  // ...
}
```
- `getConfig` **REQUIRED**: Provides the configuration for instances to distribute. Expects an Array to be returned.
- `createInstance` **REQUIRED**: Passed a configuration to create a single instance. Expects the instance to be returned.
- `healthcheckInstance` **OPTIONAL**: Passed an instance to healthcheck based on configured interval. Throwing an error means the healthcheck failing.
- `disconnectInstance` **OPTIONAL**: Passed an instance to disconnect. Used when rebalancing and stopping the service. Throwing an error means disconnecting failed.

# Settings
Various settings can configure DIM services:

```javascript
module.exports = {
  // ...

  settings: {
    dim: {
      refreshLeaderLockCronTime: '*/15 * * * *',
      healthcheckCronTime: '*/10 * * * *', 
      leaderHealthcheckCronTime: '*/5 * * * *',
      leaderLockTTL: 30
    }
  }

  // ...
}
```

- `refreshLeaderLockCronTime`: How often the leader renews its leadership. Defaults to 15s.
- `healthcheckCronTime`: How often nodes healthcheck their instances. Failed checks trigger rebalancing. Defaults to 10s.
- `leaderHealthcheckCronTime`: How often nodes check the leader's health. Failed checks trigger leader election. Defaults to 5s.
- `leaderLockTTL`: Leader key lock time in Redis. Defaults to 30s.

# Acknowledgements
- [moleculer](https://github.com/moleculerjs/moleculer)
- [moleculer-cron](https://github.com/r2d2bzh/moleculer-cron#readme)
- [redlock](https://github.com/mike-marcacci/node-redlock)

# Contributing
Contributions are welcome! Please read the contribution guidelines first.

- File an issue to report bugs or request features
- Open a pull request to submit changes and improvements

When submitting code, please:
- Follow the existing code style
- Write clear commit messages
- Add/update relevant tests and documentation
- Open an issue before submitting large changes

# License
Moleculer DIM is available under the [MIT license](https://tldrlegal.com/license/mit-license).