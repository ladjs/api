const test = require('ava');
const request = require('supertest');
const Router = require('koa-router');
const API = require('..');

test('allows custom routes', async t => {
  const router = new Router();

  router.get('/', ctx => {
    ctx.body = { ok: 'ok' };
  });

  const api = new API({
    routes: router.routes()
  });

  const res = await request(api.server).get('/');
  t.is(res.status, 200);
  t.is(res.body.ok, 'ok');
});
