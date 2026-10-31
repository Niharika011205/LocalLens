import { z } from 'zod';

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(4100),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    // Human-readable logs for local development (needs the pino-pretty dev dependency). JSON logs otherwise.
    LOG_PRETTY: bool.default(false),
    // The single browser origin allowed to make state-changing requests (CSRF defence).
    APP_ORIGIN: z.string().url(),
    MONGODB_URI: z.string().min(1),
    REDIS_URL: z.string().optional(),
    RATE_LIMIT_STORE: z.enum(['redis', 'memory']).default('redis'),
    // Requests per minute per client IP across the API. Raise it behind a shared NAT or for a load test.
    RATE_LIMIT_GLOBAL_PER_MIN: z.coerce.number().int().min(10).max(100_000).default(300),
    // AI service (optional). Unset = AI checks off: submissions go straight to editors with aiStatus "not_requested".
    AI_SERVICE_URL: z.string().url().optional(),
    AI_SERVICE_TOKEN: z.string().optional(),
    AI_TIMEOUT_MS: z.coerce.number().int().min(1000).default(600_000),
    // A reader is waiting for the assistant, so it gets a much shorter deadline than background verification.
    AI_ASSISTANT_TIMEOUT_MS: z.coerce.number().int().min(1000).default(120_000),
    // Run the background job worker in this process (one per deployment is enough at pilot scale).
    JOBS_WORKER: bool.default(true),
    COOKIE_SECURE: bool.default(true),
    // "false", "true", or a hop count such as "1". Must match the real proxy setup or client IPs will be wrong.
    TRUST_PROXY: z
      .string()
      .default('false')
      .transform((v) => (v === 'true' ? true : v === 'false' ? false : Number(v)))
      .refine((v) => typeof v === 'boolean' || (Number.isInteger(v) && v >= 0), 'TRUST_PROXY must be true, false or a hop count'),
    // Directory containing the built web app. When set, the API serves it (single-origin production deploy).
    STATIC_DIR: z.string().optional(),
    // Photos on Cloudinary: the "API environment variable" from the Cloudinary dashboard (cloudinary://key:secret@cloud).
    // Unset: photos are kept in MongoDB instead.
    CLOUDINARY_URL: z
      .string()
      .optional()
      .refine((v) => v === undefined || /^cloudinary:\/\/[^:]+:[^@]+@[\w-]+$/.test(v), 'must look like cloudinary://<api_key>:<api_secret>@<cloud_name>'),
    CLOUDINARY_FOLDER: z.string().regex(/^[\w/-]{1,60}$/).default('locallens'),
    // Map positions of places from OpenStreetMap (one lookup per place, cached). Off: no maps, only Google Maps links.
    GEOCODER_ENABLED: bool.default(true),
    GEOCODER_URL: z.string().url().default('https://nominatim.openstreetmap.org'),
    // Headlines from other news sites' public feeds (modules/aggregator/sources.ts).
    NEWS_IMPORT: bool.default(true),
    NEWS_IMPORT_INTERVAL_MIN: z.coerce.number().int().min(5).max(24 * 60).default(20),
    NEWS_KEEP_DAYS: z.coerce.number().int().min(1).max(90).default(7),
    // Quick posts: a post reported by this many different readers is removed automatically (an editor can restore it).
    REPORTS_TO_REMOVE: z.coerce.number().int().min(2).max(1000).default(10),
    // true: ticking "I want to post news" at sign-up gives reporter access at once. false: an admin approves it.
    REPORTER_SELF_SIGNUP: bool.default(true),
    // Two-step sign-in. Staff (editors, publishers, admins) must turn it on before using staff tools when enforced.
    MFA_ENFORCE: bool.default(false),
    // 32 random bytes, base64: encrypts authenticator secrets at rest. Required in production.
    //   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
    MFA_ENCRYPTION_KEY: z
      .string()
      .optional()
      .refine((v) => v === undefined || Buffer.from(v, 'base64').length === 32, 'must be 32 bytes, base64-encoded'),
  })
  .superRefine((env, ctx) => {
    if (env.AI_SERVICE_URL && (env.AI_SERVICE_TOKEN?.length ?? 0) < 32) {
      ctx.addIssue({ code: 'custom', path: ['AI_SERVICE_TOKEN'], message: 'required (32+ characters) when AI_SERVICE_URL is set' });
    }
    if (env.RATE_LIMIT_STORE === 'redis' && !env.REDIS_URL) {
      ctx.addIssue({ code: 'custom', path: ['REDIS_URL'], message: 'required when RATE_LIMIT_STORE=redis' });
    }
    if (env.NODE_ENV === 'production') {
      const rules: [boolean, keyof typeof env, string][] = [
        [env.COOKIE_SECURE, 'COOKIE_SECURE', 'must be true in production'],
        [env.RATE_LIMIT_STORE === 'redis', 'RATE_LIMIT_STORE', 'must be redis in production'],
        [env.APP_ORIGIN.startsWith('https://'), 'APP_ORIGIN', 'must use https in production'],
        [env.MFA_ENFORCE, 'MFA_ENFORCE', 'must be true in production (staff accounts can publish)'],
        [!!env.MFA_ENCRYPTION_KEY, 'MFA_ENCRYPTION_KEY', 'required in production'],
      ];
      for (const [ok, path, message] of rules) {
        if (!ok) ctx.addIssue({ code: 'custom', path: [path], message });
      }
    }
  });

export type Config = z.infer<typeof EnvSchema>;

export class ConfigError extends Error {
  override name = 'ConfigError';
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Hosting platforms inject PORT; dev tooling (e.g. a preview runner for the web app) may inject it too.
  // API_PORT, when set, wins so local development never collides with the web dev server.
  // On Render the service's own https address is provided as RENDER_EXTERNAL_URL: it is the app origin unless set.
  const withOrigin = !env.APP_ORIGIN && env.RENDER_EXTERNAL_URL ? { ...env, APP_ORIGIN: env.RENDER_EXTERNAL_URL } : env;
  const source = withOrigin.API_PORT ? { ...withOrigin, PORT: withOrigin.API_PORT } : withOrigin;
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new ConfigError(`Invalid environment configuration:\n${lines.join('\n')}`);
  }
  return parsed.data;
}
