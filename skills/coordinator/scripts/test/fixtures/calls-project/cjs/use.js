const lib = require('./lib');
const { two } = require('./lib');

exports.go = function () {
  lib.one();
  lib.three();
  return two();
};
