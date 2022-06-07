const Passport = require('@ladjs/passport');
const Redis = require('ioredis-mock');
const Router = require('@koa/router');
const request = require('supertest');
const test = require('ava');

const API = require('..');

test('allows custom routes', async (t) => {
  const router = new Router();

  router.get('/', (ctx) => {
    ctx.body = { ok: 'ok' };
  });

  const api = new API({
    redis: new Redis(),
    routes: router.routes()
  });

  const response = await request(api.server).get('/');
  t.is(response.status, 200);
  t.is(response.body.ok, 'ok');
});

test('with redis instance', (t) => {
  const api = new API({ redis: new Redis() });
  t.is(typeof api.client, 'object');
  t.is(typeof api.app.context.client, 'object');
});

test('without redis instance', (t) => {
  const api = new API({ redis: false });
  t.is(api.client, false);
  t.is(api.app.context.client, false);
});

test('with passport instance', (t) => {
  const passport = new Passport({});
  const api = new API({ passport, redis: new Redis() });
  t.is(typeof api.passport, 'object');
  t.is(typeof api.app.context.passport, 'object');
});

test('without passport instance', (t) => {
  const api = new API({ redis: new Redis() });
  t.is(api.passport, false);
  t.is(api.app.context.passport, false);
});
