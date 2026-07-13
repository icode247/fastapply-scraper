const companiesRepo = require('./repositories/companies');
const jobsRepo = require('./repositories/jobs');
const { migrate } = require('./schema');
const { closeDb } = require('./connection');

module.exports = { companiesRepo, jobsRepo, migrate, closeDb };
