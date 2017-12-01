const test = require('ava');
const request = require('supertest');
const Router = require('koa-router');
const Server = require('..');
const Users = require('./fixtures/models/user');

const ok = ctx => {
  ctx.status = 200;
  ctx.body = { ok: 'ok' };
};

const error = () => {
  throw new Error('Big Bad Error!');
};

const config = {
  cabin: {},
  protocol: process.env.API_PROTOCOL | 'http',
  port: process.env.API_PORT || 4000,
  ssl: {
    key: null,
    cert: null,
    ca: null
  },
  Users: false,
  routes: false,
  logger: console,
  i18n: {},
  rateLimit: {
    duration: 60000,
    max: 100,
    id: ctx => ctx.ip
  },
  timeoutMs: 2000
};

test('returns self', t => {
  const tempConfig = config;
  const server = new Server();
  t.true(server instanceof Server);

  // We have to delete this key since it's an arrow function
  // and arrow functions cant be asserted
  delete tempConfig.rateLimit.id;
  delete server.config.rateLimit.id;
  t.deepEqual(server.config, tempConfig);
});

test.failing('allows custom routes', async t => {
  const router = new Router();

  router.get('/', ok);
  router.get('/error', error);

  const server = new Server({
    routes: router.routes(),
    Users
  });

  const res = await request(server.server).get('/');
  t.is(res.status, 200);
  t.is(res.body.ok, 'ok');
});
