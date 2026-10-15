'use strict';

const policy = require('./workflow-policy.js');
if (require.main === module) {
  if (['selftest', 'report'].includes(process.argv[2])) {
    process.stderr.write('Legacy transcript checks were removed in 1.5. Run npm test in the workflow-kit repository.\n');
    process.exitCode = 1;
  } else policy.main();
}
module.exports = policy;
