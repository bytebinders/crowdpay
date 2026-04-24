const { AsyncLocalStorage } = require('async_hooks');

const als = new AsyncLocalStorage();

function getRequestContext() {
  return als.getStore() || {};
}

function runWithContext(context, fn) {
  return als.run(context, fn);
}

module.exports = { getRequestContext, runWithContext };
