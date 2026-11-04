'use strict'

// The `.node` addon is produced by `scripts/build-napi.mjs` and is gitignored.
const { join } = require('node:path')

module.exports = require(join(__dirname, 'lib', 'mongo.node'))
