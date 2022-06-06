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

const RATE_LIMIT_EXCEEDED = 'Rate limit exceeded, retry in %s.';

class API {
  // eslint-disable-next-line complexity
  constructor(config, Users) {
    this.config = {
      ...sharedConfig('API'),
      rateLimitIgnoredGlobs: [],
      ...config
    };

    // Initialize the app
    const app = new Koa();

    // Only trust proxy if enabled
    app.proxy = boolean(process.env.TRUST_PROXY);

    // Specify that this is our api (used by error handler)
    app.context.api = true;

    // Initialize cabin
    this.logger = _.isPlainObject(this.config.logger)
      ? new Cabin(this.config.logger)
      : this.config.logger instanceof Cabin
      ? this.config.logger
      : new Cabin({
          logger: this.config.logger ? this.config.logger : console
        });
    app.context.logger = this.logger;

    // Initialize redis
    this.client =
      this.config.redis === false
        ? false
        : _.isPlainObject(this.config.redis)
        ? new Redis(this.config.redis, this.logger, this.config.redisMonitor)
        : this.config.redis;
    app.context.client = this.client;

    // Expose passport
    this.passport =
      this.config.passport === false
        ? false
        : _.isPlainObject(this.config.passport)
        ? new Passport(this.config.passport, Users)
        : this.config.passport;
    app.context.passport = this.passport;

    // Listen for errors emitted by app
    app.on('error', (error, ctx) => {
      ctx.logger[error.status && error.status < 500 ? 'warn' : 'error'](error);
    });

    // Override koa's undocumented error handler
    app.context.onerror = errorHandler(false);

    // Adds request received hrtime and date symbols to request object
    // (which is used by Cabin internally to add `request.timestamp` to logs
    app.use(requestReceived);

    // Configure timeout
    if (this.config.timeout) {
      const timeout = new Timeout(this.config.timeout);
      app.use(timeout.middleware);
    }

    // Adds `X-Response-Time` header to responses
    app.use(koaConnect(responseTime()));

    // Adds or re-uses `X-Request-Id` header
    app.use(koaConnect(requestId()));

    // Use the cabin middleware (adds request-based logging and helpers)
    app.use(this.logger.middleware);

    // Allow before hooks to get setup
    if (_.isFunction(this.config.hookBeforeSetup)) {
      this.config.hookBeforeSetup(app);
    }

    // Basic auth
    if (this.config.auth) {
      app.use(auth(this.config.auth));
    }

    // Rate limiting
    if (this.client && this.config.rateLimit) {
      app.use((ctx, next) => {
        // Check against ignored/whitelisted paths
        if (
          Array.isArray(this.config.rateLimitIgnoredGlobs) &&
          this.config.rateLimitIgnoredGlobs.length > 0
        ) {
          const match = multimatch(ctx.path, this.config.rateLimitIgnoredGlobs);
          if (Array.isArray(match) && match.length > 0) {
            return next();
          }
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

    // Remove trailing slashes
    app.use(removeTrailingSlashes());

    // I18n
    if (this.config.i18n) {
      const i18n = this.config.i18n.config
        ? this.config.i18n
        : new I18N({ ...this.config.i18n, logger: this.logger });
      app.use(i18n.middleware);
    }

    // Conditional-get
    app.use(conditional());

    // Etag
    app.use(etag());

    // Cors
    if (this.config.cors) {
      app.use(cors(this.config.cors));
    }

    // Body parser
    app.use(bodyParser());

    // Pretty-printed json responses
    app.use(json());

    // Passport
    if (this.passport) {
      app.use(this.passport.initialize());
    }

    // Store the user's last ip address in the background
    if (this.config.storeIPAddress) {
      const storeIPAddress = new StoreIPAddress({
        logger: this.logger,
        ...this.config.storeIPAddress
      });
      app.use(storeIPAddress.middleware);
    }

    // 404 handler
    app.use(koa404Handler);

    // Allow before hooks to get setup
    if (_.isFunction(this.config.hookBeforeRoutes)) {
      this.config.hookBeforeRoutes(app);
    }

    // Mount the app's defined and nested routes
    if (this.config.routes) {
      if (_.isFunction(this.config.routes.routes)) {
        app.use(this.config.routes.routes());
      } else {
        app.use(this.config.routes);
      }
    }

    // Start server on either http or https
    this.server =
      this.config.protocol === 'https'
        ? https.createServer(this.config.ssl, app.callback())
        : http.createServer(app.callback());

    // Expose the app
    this.app = app;

    // Bind listen/close to this
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
