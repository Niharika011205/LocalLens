import { randomUUID } from 'node:crypto';
import path from 'node:path';
import cookieParser from 'cookie-parser';
import express, { Router } from 'express';
import helmet from 'helmet';
import type { Logger } from 'pino';
import { pinoHttp } from 'pino-http';
import type { Config } from './config';
import { loadSession, setMfaEnforcement } from './middleware/auth';
import { errorHandler, notFoundHandler } from './middleware/error-handler';
import { rateLimit, type RateLimiters } from './middleware/rate-limit';
import { originCheck, requireJsonBody } from './middleware/security';
import { adminRouter } from './modules/identity/admin.routes';
import { authRouter } from './modules/identity/auth.routes';
import { AuthService } from './modules/identity/auth.service';
import { meRouter } from './modules/identity/me.routes';
import { categoriesRouter } from './modules/catalog/catalog';
import { engagementRouter } from './modules/engagement/engagement';
import { adminLocationsRouter, locationsRouter } from './modules/geo/geo.routes';
import { articlesRouter, editorialRouter } from './modules/publishing/articles.routes';
import { articlePreviewHandler } from './modules/publishing/og';
import { articleReportsRouter, moderationRouter } from './modules/moderation/reports';
import { editorialQueueRouter, reporterRouter } from './modules/newsroom/newsroom.routes';
import { adminPublishersRouter, publisherRouter } from './modules/newsroom/publishers';
import type { PublicConfig } from '@locallens/contracts';
import { adminOpsRouter } from './modules/admin/ops';
import { adminNewsRouter, configureAggregator } from './modules/aggregator/aggregator';
import { configureGeocoder } from './modules/geo/geocode';
import { configureMedia, mediaRouter } from './modules/media/media';
import { heldPostsRouter, postsRouter } from './modules/posts/posts';
import { adminMfaRouter, MfaService, mfaKey, mfaRouter } from './modules/identity/mfa';
import { assistantRouter } from './modules/assistant/assistant';
import { editorialAppealsRouter, reporterAppealsRouter } from './modules/newsroom/appeals';
import { configureNotifications, notificationsRouter } from './modules/notifications/notifications';
import { configureVerification, verificationRouter } from './modules/verification/verification';

export interface AppDeps {
  config: Config;
  logger: Logger;
  limiters: RateLimiters;
  /** Readiness probe: true when every hard dependency (MongoDB) is reachable. */
  isReady: () => Promise<boolean>;
}

const REQUEST_ID = /^[A-Za-z0-9-]{8,64}$/;

export function createApp(deps: AppDeps): express.Express {
  const { config, logger, limiters } = deps;
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', config.TRUST_PROXY);

  app.use(
    pinoHttp({
      logger,
      // Reuse a well-formed incoming request ID (from a proxy) so logs can be correlated across hops.
      genReqId: (req, res) => {
        const incoming = req.headers['x-request-id'];
        const id = typeof incoming === 'string' && REQUEST_ID.test(incoming) ? incoming : randomUUID();
        res.setHeader('X-Request-Id', id);
        return id;
      },
      autoLogging: { ignore: (req) => req.url === '/healthz' || req.url === '/readyz' },
      // Log what is needed to debug and correlate, not every header (smaller logs, less accidental data capture).
      serializers: {
        req: (req: { id: unknown; method: string; url: string; remoteAddress?: string }) => ({
          id: req.id,
          method: req.method,
          url: req.url,
          remoteAddress: req.remoteAddress,
        }),
        res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
      },
    }),
  );

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          'frame-ancestors': ["'none'"],
          // Photos come from Cloudinary and, for imported stories, from the news sites; blob: is the photo preview.
          'img-src': ["'self'", 'data:', 'blob:', 'https:'],
          // Only meaningful over https; would break plain-http local development.
          'upgrade-insecure-requests': config.NODE_ENV === 'production' ? [] : null,
        },
      },
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
      // HSTS only means something over https; production sits behind TLS.
      strictTransportSecurity: config.NODE_ENV === 'production',
    }),
  );

  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok' });
  });
  app.get('/readyz', async (_req, res) => {
    const ready = await deps.isReady().catch(() => false);
    res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'not_ready' });
  });

  const mfa = new MfaService(mfaKey(config, logger));
  setMfaEnforcement(config.MFA_ENFORCE);
  const auth = new AuthService({ limiters, mfa, reporterSelfSignup: config.REPORTER_SELF_SIGNUP });
  configureVerification(config, logger);
  configureNotifications();
  configureMedia({ cloudinaryUrl: config.CLOUDINARY_URL, folder: config.CLOUDINARY_FOLDER });
  configureGeocoder({ enabled: config.GEOCODER_ENABLED, baseUrl: config.GEOCODER_URL, appOrigin: config.APP_ORIGIN, logger });
  configureAggregator({ enabled: config.NEWS_IMPORT, intervalMin: config.NEWS_IMPORT_INTERVAL_MIN, keepDays: config.NEWS_KEEP_DAYS, logger });
  const api = Router();
  api.use(rateLimit(limiters.global, { failClosed: false }));
  api.use(originCheck(config.APP_ORIGIN));
  api.use(requireJsonBody);
  api.use(express.json({ limit: '100kb' }));
  api.use(cookieParser());
  api.use(loadSession);
  api.get('/config', (_req, res) => {
    res.json({ reporterSelfSignup: config.REPORTER_SELF_SIGNUP, removeAfterReports: config.REPORTS_TO_REMOVE, assistant: !!config.AI_SERVICE_URL } satisfies PublicConfig);
  });
  api.use('/auth', authRouter({ auth, limiters, cookieSecure: config.COOKIE_SECURE }));
  api.use('/me', meRouter(auth, config.REPORTER_SELF_SIGNUP));
  api.use('/me', mfaRouter({ mfa, enforced: config.MFA_ENFORCE }));
  api.use('/me', engagementRouter());
  api.use('/me', notificationsRouter());
  api.use('/admin/locations', adminLocationsRouter());
  api.use('/admin', adminRouter());
  api.use('/admin', adminPublishersRouter());
  api.use('/admin', adminOpsRouter(config));
  api.use('/admin', adminMfaRouter());
  api.use('/admin', adminNewsRouter({ keepDays: config.NEWS_KEEP_DAYS, logger }));
  api.use('/locations', locationsRouter());
  api.use('/categories', categoriesRouter());
  api.use('/articles', articlesRouter());
  api.use('/articles', articleReportsRouter({ removeAfterReports: config.REPORTS_TO_REMOVE }));
  api.use('/editorial', editorialRouter());
  api.use('/editorial', editorialQueueRouter());
  api.use('/editorial', verificationRouter(config));
  api.use('/editorial', editorialAppealsRouter());
  api.use('/submissions', reporterAppealsRouter());
  api.use('/submissions', reporterRouter());
  api.use('/publisher', publisherRouter());
  api.use('/moderation', moderationRouter());
  api.use('/moderation', heldPostsRouter());
  api.use('/posts', postsRouter({ limiters, removeAfterReports: config.REPORTS_TO_REMOVE }));
  api.use('/media', mediaRouter());
  api.use('/assistant', assistantRouter({ config, limiters, logger }));
  api.use(notFoundHandler);
  app.use('/api/v1', api);

  if (config.STATIC_DIR) {
    const dir = path.resolve(config.STATIC_DIR);
    // Hashed asset files can be cached forever; index.html must always be revalidated to pick up new deploys.
    app.use('/assets', express.static(path.join(dir, 'assets'), { immutable: true, maxAge: '1y', fallthrough: false }));
    app.use(
      express.static(dir, {
        index: false,
        maxAge: '1h',
        // The service worker and manifest must update promptly after a deploy.
        setHeaders: (res, file) => {
          if (/(sw\.js|manifest\.webmanifest)$/.test(file)) res.setHeader('Cache-Control', 'no-cache');
        },
      }),
    );
    app.use(articlePreviewHandler(dir, config.APP_ORIGIN));
    app.use((req, res, next) => {
      if (req.method !== 'GET' || req.path.startsWith('/api/')) return next();
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(path.join(dir, 'index.html'));
    });
  }

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
