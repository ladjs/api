const process = require('process');
const http = require('http');
const https = require('https');
const util = require('util');

const Cabin = require('cabin');
const I18N = require('@ladjs/i18n');
const Passport = require('@ladjs/passport');
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
const ms = require('ms');
const multimatch = require('multimatch');
const ratelimit = require('@ladjs/koa-simple-ratelimit');
const removeTrailingSlashes = require('koa-no-trailing-slash');
const requestId = require('express-request-id');
const requestReceived = require('request-received');
const responseTime = require('response-time');
const sharedConfig = require('@ladjs/shared-config');
const { boolean } = require('boolean');

const RATE_LIMIT_EXCEEDED = `Rate limit exceeded, retry in %s.`;

class API {
  // eslint-disable-next-line complexity
  constructor(config, Users) {
    this.config = {
      ...sharedConfig('API'),
      rateLimitIgnoredGlobs: [],
      ...config
    };

    // initialize the app
    const app = new Koa();

    // only trust proxy if enabled
    app.proxy = boolean(process.env.TRUST_PROXY);

    // specify that this is our api (used by error handler)
    app.context.api = true;

    // initialize cabin
    this.logger = _.isPlainObject(this.config.logger)
      ? new Cabin(this.config.logger)
      : this.config.logger instanceof Cabin
      ? this.config.logger
      : new Cabin({
          logger: this.config.logger ? this.config.logger : console
        });
    app.context.logger = this.logger;

    // initialize redis
    this.client =
      this.config.redis === false
        ? false
        : _.isPlainObject(this.config.redis)
        ? new Redis(this.config.redis, this.logger, this.config.redisMonitor)
        : this.config.redis;
    app.context.client = this.client;

    // expose passport
    this.passport =
      this.config.passport === false
        ? false
        : _.isPlainObject(this.config.passport)
        ? new Passport(this.config.passport, Users)
        : this.config.passport;
    app.context.passport = this.passport;

    // listen for errors emitted by app
    app.on('error', (err, ctx) => {
      ctx.logger[err.status && err.status < 500 ? 'warn' : 'error'](err);
    });

    // override koa's undocumented error handler
    app.context.onerror = errorHandler(false, this.logger);

    // adds request received hrtime and date symbols to request object
    // (which is used by Cabin internally to add `request.timestamp` to logs
    app.use(requestReceived);

    // configure timeout
    if (this.config.timeout) {
      const timeout = new Timeout(this.config.timeout);
      app.use(timeout.middleware);
    }

    // adds `X-Response-Time` header to responses
    app.use(koaConnect(responseTime()));

    // adds or re-uses `X-Request-Id` header
    app.use(koaConnect(requestId()));

    // use the cabin middleware (adds request-based logging and helpers)
    app.use(this.logger.middleware);

    // allow before hooks to get setup
    if (_.isFunction(this.config.hookBeforeSetup))
      this.config.hookBeforeSetup(app);

    // basic auth
    if (this.config.auth) app.use(auth(this.config.auth));

    // rate limiting
    if (this.client && this.config.rateLimit) {
      app.use((ctx, next) => {
        // check against ignored/whitelisted paths
        if (
          Array.isArray(this.config.rateLimitIgnoredGlobs) &&
          this.config.rateLimitIgnoredGlobs.length > 0
        ) {
          const match = multimatch(ctx.path, this.config.rateLimitIgnoredGlobs);
          if (Array.isArray(match) && match.length > 0) return next();
        }

        return ratelimit({
          ...this.config.rateLimit,
          db: this.client,
          logger: this.logger,
          errorMessage(exp) {
            const fn =
              typeof ctx.request.t === 'function' ? ctx.request.t : util.format;
            // NOTE: ms does not support i18n localization
            return fn(RATE_LIMIT_EXCEEDED, ms(exp, { long: true }));
          }
        })(ctx, next);
      });
    }

    // remove trailing slashes
    app.use(removeTrailingSlashes());

    // i18n
    if (this.config.i18n) {
      const i18n = this.config.i18n.config
        ? this.config.i18n
        : new I18N({ ...this.config.i18n, logger: this.logger });
      app.use(i18n.middleware);
    }

    // conditional-get
    app.use(conditional());

    // etag
    app.use(etag());

    // cors
    if (this.config.cors) app.use(cors(this.config.cors));

    // body parser
    app.use(bodyParser());

    // pretty-printed json responses
    app.use(json());

    // passport
    if (this.passport) app.use(this.passport.initialize());

    // store the user's last ip address in the background
    if (this.config.storeIPAddress) {
      const storeIPAddress = new StoreIPAddress({
        logger: this.logger,
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

    // start server on either http or https
    this.server =
      this.config.protocol === 'https'
        ? https.createServer(this.config.ssl, app.callback())
        : http.createServer(app.callback());

    // expose the app
    this.app = app;

    // bind listen/close to this
    this.listen = this.listen.bind(this);
    this.close = this.close.bind(this);
  }

  async listen(
    port = this.config.port,
    host = this.config.serverHost,
    ...args
  ) {
    await util.promisify(this.server.listen).bind(this.server)(
      port,
      host,
      ...args
    );
  }

  async close() {
    await util.promisify(this.server.close).bind(this.server);
  }
}

module.exports = API;
