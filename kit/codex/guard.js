'use strict';

const policy = require('./workflow-policy.js');
if (require.main === module) policy.main();
module.exports = policy;
