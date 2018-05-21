const http = require('http');
const https = require('https');
const fs = require('fs');
const autoBind = require('auto-bind');
const _ = require('lodash');
const Koa = require('koa');
const Cabin = require('cabin');
const boolean = require('boolean');
const conditional = require('koa-conditional-get');
const etag = require('koa-etag');
const compress = require('koa-compress');
const responseTime = require('koa-response-time');
const rateLimit = require('koa-simple-ratelimit');
const koaLogger = require('koa-logger');
const bodyParser = require('koa-bodyparser');
const koa404Handler = require('koa-404-handler');
const json = require('koa-json');
const errorHandler = require('koa-better-error-handler');
const helmet = require('koa-helmet');
const removeTrailingSlashes = require('koa-no-trailing-slash');
const redis = require('redis');
const StoreIPAddress = require('@ladjs/store-ip-address');
const ip = require('ip');
const Timeout = require('koa-better-timeout');
const I18N = require('@ladjs/i18n');
const { oneLine } = require('common-tags');

const env = process.env.NODE_ENV || 'development';

let max = process.env.RATELIMIT_MAX
  ? parseInt(process.env.RATELIMIT_MAX, 10)
  : 100;

if (!process.env.RATELIMIT_MAX && env === 'development') max = Number.MAX_VALUE;

class Server {
  constructor(config) {
    this.config = Object.assign(
      {
        cabin: {},
        protocol: process.env.API_PROTOCOL || 'http',
        ssl: {
          key: process.env.API_SSL_KEY_PATH
            ? fs.readFileSync(process.env.API_SSL_KEY_PATH)
            : null,
          cert: process.env.API_SSL_CERT_PATH
            ? fs.readFileSync(process.env.API_SSL_CERT_PATH)
            : null,
          ca: process.env.API_SSL_CA_PATH
            ? fs.readFileSync(process.env.API_SSL_CA_PATH)
            : null
        },
        routes: false,
        logger: console,
        passport: false,
        i18n: {},
        rateLimit: {
          duration: process.env.RATELIMIT_DURATION
            ? parseInt(process.env.RATELIMIT_DURATION, 10)
            : 60000,
          max,
          id: ctx => ctx.ip,
          prefix: process.env.RATELIMIT_PREFIX
            ? process.env.RATELIMIT_PREFIX
            : `limit_${env.toLowerCase()}`
        },
        timeoutMs: process.env.API_TIMEOUT_MS
          ? parseInt(process.env.API_TIMEOUT_MS, 10)
          : 2000
      },
      config
    );

    const { logger } = this.config;
    const storeIPAddress = new StoreIPAddress({ logger });
    const i18n = this.config.i18n.config
      ? this.config.i18n
      : new I18N({ ...this.config.i18n, logger });
    const cabin = new Cabin(this.config.cabin);

    // initialize the app
    const app = new Koa();

    // connect to redis
    const redisClient = redis.createClient(
      process.env.REDIS_URL || 'redis://localhost:6379'
    );
    // handle connect and error events
    redisClient.on('connect', () =>
      app.emit('log', 'debug', 'redis connected')
    );
    redisClient.on('error', err => app.emit('error', err));

    // store the server initialization
    // so that we can gracefully exit
    // later on with `server.close()`
    let server;

    app.on('error', logger.contextError || logger.error);
    app.on('log', logger.log);

    // only trust proxy if enabled
    app.proxy = boolean(process.env.TRUST_PROXY);

    // compress/gzip
    app.use(compress());

    // setup localization
    app.use(i18n.middleware);

    // specify that this is our api (used by error handler)
    app.context.api = true;

    // override koa's undocumented error handler
    // TODO: <https://github.com/sindresorhus/eslint-plugin-unicorn/issues/174>
    // eslint-disable-next-line unicorn/prefer-add-event-listener
    app.context.onerror = errorHandler;

    // response time
    app.use(responseTime());

    // request logger with custom logger
    app.use(koaLogger({ logger }));

    // rate limiting
    app.use(
      rateLimit({
        ...this.config.rateLimit,
        db: redisClient
      })
    );

    // conditional-get
    app.use(conditional());

    // etag
    app.use(etag());

    // security
    app.use(helmet());

    // remove trailing slashes
    app.use(removeTrailingSlashes());

    // body parser
    app.use(bodyParser());

    // pretty-printed json responses
    app.use(json());

    // add cabin middleware
    app.use(cabin.middleware);

    // 404 handler
    app.use(koa404Handler);

    // passport
    if (this.config.passport) app.use(this.config.passport.initialize());

    // configure timeout
    app.use(async (ctx, next) => {
      try {
        const timeout = new Timeout({
          ms: this.config.timeoutMs,
          message: ctx.req.t(
            oneLine`Sorry, your request has timed out.
            We have been alerted of this issue.  Please try again.`
          )
        });
        await timeout.middleware(ctx, next);
      } catch (err) {
        ctx.throw(err);
      }
    });

    // store the user's last ip address in the background
    app.use(storeIPAddress.middleware);

    // mount the app's defined and nested routes
    if (this.config.routes) {
      if (_.isFunction(this.config.routes.routes))
        app.use(this.config.routes.routes());
      else app.use(this.config.routes);
    }

    // start server on either http or https
    if (this.config.protocol === 'https')
      server = https.createServer(this.config.ssl, app.callback());
    else server = http.createServer(app.callback());

    // expose app and server
    this.app = app;
    this.server = server;

    // Expose app so we can test it without the server wrapper
    if (env === 'test') this.app = app;

    autoBind(this);
  }

  listen(port, fn) {
    if (_.isFunction(port)) {
      fn = port;
      port = null;
    }

    const { logger } = this.config;
    if (!_.isFunction(fn))
      fn = function() {
        const { port } = this.address();
        logger.info(
          `api server listening on ${port} (LAN: ${ip.address()}:${port})`
        );
      };

    this.server = this.server.listen(port, fn);
    return this.server;
  }

  close(fn) {
    this.server.close(fn);
    return this;
  }
}

module.exports = Server;
