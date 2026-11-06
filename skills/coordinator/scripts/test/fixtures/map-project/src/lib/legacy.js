// CommonJS, with a regex and a template literal the lexer must not trip on.
const { markEwaDisbursed } = require('../services/ewa.service');
const ewa = require('../services/employer.service');

const SLASHES = /\/+$/g;
module.exports = {
  pay: (n) => `${markEwaDisbursed(n)} ${ewa.loadEmployer('x').id}`.replace(SLASHES, ''),
};
