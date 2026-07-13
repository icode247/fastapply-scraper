const greenhouse = require('./greenhouse');
const ashby = require('./ashby');
const lever = require('./lever');
const workable = require('./workable');
const recruitee = require('./recruitee');
const smartrecruiters = require('./smartrecruiters');
const rippling = require('./rippling');
const personio = require('./personio');
const breezy = require('./breezy');
const jazzhr = require('./jazzhr');
const workday = require('./workday');
const zoho = require('./zoho');
const icims = require('./icims');
const oracle = require('./oracle');
const bamboohr = require('./bamboohr');
const taleo = require('./taleo');
const pinpoint = require('./pinpoint');
const successfactors = require('./successfactors');
const comeet = require('./comeet');
const paylocity = require('./paylocity');

const adapters = {
  greenhouse,
  ashby,
  lever,
  workable,
  recruitee,
  smartrecruiters,
  rippling,
  personio,
  breezy,
  jazzhr,
  workday,
  zoho,
  icims,
  oracle,
  bamboohr,
  taleo,
  pinpoint,
  successfactors,
  comeet,
  paylocity,
};

function getAdapter(atsName) {
  const adapter = adapters[atsName];
  if (!adapter) throw new Error(`Unsupported ATS: ${atsName}`);
  return adapter;
}

module.exports = { getAdapter };
