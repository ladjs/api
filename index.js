const http = require('http');
const https = require('https');
// const http2 = require('http2');
const util = require('util');

const Cabin = require('cabin');
const I18N = require('@ladjs/i18n');
const Koa = require('koa');
const Redis = require('@ladjs/redis');
const StoreIPAddress = require('@ladjs/store-ip-address');
const Timeout = require('koa-better-timeout');
const _ = require('lodash');
const auth = require('koa-basic-auth');
const bodyParser = require('koa-bodyparser');
const conditional = require('koa-conditional-get');
const cors = require('kcors');
const errorHandler = require('koa-better-error-handler');
const etag = require('koa-etag');
const json = require('koa-json');
const koa404Handler = require('koa-404-handler');
const koaConnect = require('koa-connect');
const proxyWrap = require('findhit-proxywrap');
const removeTrailingSlashes = require('koa-no-trailing-slash');
const requestId = require('express-request-id');
const requestReceived = require('request-received');
const responseTime = require('response-time');
const sharedConfig = require('@ladjs/shared-config');
const { boolean } = require('boolean');
const { ratelimit } = require('koa-simple-ratelimit');

const proxiedHttp = proxyWrap.proxy(http);
const proxiedHttps = proxyWrap.proxy(https);

class API {
  constructor(config) {
    this.config = {
      ...sharedConfig('API'),
      ...config
    };

    const cabin = new Cabin({
      logger: this.config.logger,
      ...this.config.cabin
    });

    // initialize the app
    const app = new Koa();

    // listen for error and log events emitted by app
    app.on('error', (err, ctx) => {
      const level = err.status && err.status < 500 ? 'warn' : 'error';
      if (ctx.logger) ctx.logger[level](err);
      else cabin[level](err);
    });
    app.on('log', cabin.log);

    // initialize redis
    const client = new Redis(
      this.config.redis,
      cabin,
      this.config.redisMonitor
    );

    // store the server initialization
    // so that we can gracefully exit
    // later on with `server.close()`
    let server;

    // allow middleware to access redis client
    app.context.client = client;

    // override koa's undocumented error handler
    app.context.onerror = errorHandler(false, cabin);

    // only trust proxy if enabled
    app.proxy = boolean(process.env.TRUST_PROXY);

    // specify that this is our api (used by error handler)
    app.context.api = true;

    // allow before hooks to get setup
    if (_.isFunction(this.config.hookBeforeSetup))
      this.config.hookBeforeSetup(app);

    // rate limiting
    if (this.config.rateLimit)
      app.use(
        ratelimit({
          ...this.config.rateLimit,
          db: client
        })
      );

    // basic auth
    if (this.config.auth) app.use(auth(this.config.auth));

    // configure timeout
    if (this.config.timeout) {
      const timeout = new Timeout(this.config.timeout);
      app.use(timeout.middleware);
    }

    // adds request received hrtime and date symbols to request object
    // (which is used by Cabin internally to add `request.timestamp` to logs
    app.use(requestReceived);

    // adds `X-Response-Time` header to responses
    app.use(koaConnect(responseTime()));

    // adds or re-uses `X-Request-Id` header
    app.use(koaConnect(requestId()));

    // use the cabin middleware (adds request-based logging and helpers)
    app.use(cabin.middleware);

    // setup localization
    if (this.config.i18n) {
      const i18n = this.config.i18n.config
        ? this.config.i18n
        : new I18N({ ...this.config.i18n, logger: cabin });
      app.use(i18n.middleware);
    }

    // conditional-get
    app.use(conditional());

    // etag
    app.use(etag());

    // cors
    if (this.config.cors) app.use(cors(this.config.cors));

    // remove trailing slashes
    app.use(removeTrailingSlashes());

    // body parser
    app.use(bodyParser());

    // pretty-printed json responses
    app.use(json());

    // passport
    if (this.config.passport) app.use(this.config.passport.initialize());

    // store the user's last ip address in the background
    if (this.config.storeIPAddress) {
      const storeIPAddress = new StoreIPAddress({
        logger: cabin,
        ...this.config.storeIPAddress
      });
      app.use(storeIPAddress.middleware);
    }

    // 404 handler
    app.use(koa404Handler);

    // allow before hooks to get setup
    if (_.isFunction(this.config.hookBeforeRoutes))
      this.config.hookBeforeRoutes(app);

    // mount the app's defined and nested routes
    if (this.config.routes) {
      if (_.isFunction(this.config.routes.routes))
        app.use(this.config.routes.routes());
      else app.use(this.config.routes);
    }

    const createServer =
      this.config.protocol === 'https'
        ? this.config.proxyProtocol
          ? proxiedHttps.createServer
          : https.createServer
        : this.config.proxyProtocol
        ? proxiedHttp.createServer
        : http.createServer;

    // start server on either http or https
    if (this.config.protocol === 'https')
      server = createServer(this.config.ssl, app.callback());
    // server = http2.createSecureServer(this.config.ssl, app.callback());
    else server = createServer(app.callback());

    // expose app, server, client
    this.app = app;
    this.server = server;
    this.client = client;

    // bind listen/close to this
    this.listen = this.listen.bind(this);
    this.close = this.close.bind(this);
  }

  async listen(port) {
    await util.promisify(this.server.listen).bind(this.server)(port);
  }

  async close() {
    await util.promisify(this.server.close).bind(this.server);
  }
}

module.exports = API;
