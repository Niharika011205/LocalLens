import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { RequestHandler } from 'express';
import { ArticleModel } from './article.model';

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/**
 * The web app is a single-page app, so link previews (WhatsApp, Facebook, X) would otherwise show nothing useful.
 * For /articles/:slug this injects Open Graph tags into index.html on the server. Only published and retracted articles
 * get tags; anything else falls back to the plain page, so unpublished headlines never leak through previews.
 */
export function articlePreviewHandler(staticDir: string, appOrigin: string): RequestHandler {
  // Re-read index.html when it changes: a new build points to new asset files, and an old copy would load old code.
  const file = path.join(staticDir, 'index.html');
  let cached: { mtimeMs: number; html: Promise<string> } | null = null;
  const loadTemplate = async () => {
    const { mtimeMs } = await stat(file);
    if (!cached || cached.mtimeMs !== mtimeMs) cached = { mtimeMs, html: readFile(file, 'utf8') };
    return cached.html;
  };

  return async (req, res, next) => {
    const slug = /^\/articles\/([a-z0-9-]{3,80})$/.exec(req.path)?.[1];
    if (req.method !== 'GET' || !slug) return next();
    const [html, article] = await Promise.all([
      loadTemplate(),
      ArticleModel.findOne({ slug, status: { $in: ['published', 'retracted'] } }, { headline: 1, summary: 1, status: 1, language: 1, imageUrl: 1, imageId: 1 }),
    ]);
    if (!article) return next();

    const title = article.status === 'retracted' ? `[Retracted] ${article.headline}` : article.headline;
    const origin = new URL(appOrigin).origin;
    const url = `${origin}/articles/${slug}`;
    // The photo makes shared links on WhatsApp/Facebook show a picture (not for retracted stories).
    const image = article.status === 'retracted' ? null : article.imageUrl ?? (article.imageId ? `${origin}/api/v1/media/${article.imageId.toHexString()}` : null);
    const tags = [
      `<meta property="og:type" content="article" />`,
      `<meta property="og:site_name" content="LocalLens" />`,
      `<meta property="og:title" content="${escapeHtml(title)}" />`,
      `<meta property="og:description" content="${escapeHtml(article.summary)}" />`,
      `<meta property="og:url" content="${escapeHtml(url)}" />`,
      `<meta property="og:locale" content="${article.language === 'te' ? 'te_IN' : 'en_IN'}" />`,
      ...(image ? [`<meta property="og:image" content="${escapeHtml(image)}" />`] : []),
      `<meta name="twitter:card" content="${image ? 'summary_large_image' : 'summary'}" />`,
      `<link rel="canonical" href="${escapeHtml(url)}" />`,
    ].join('\n    ');
    const page = html
      .replace(/<title>[^<]*<\/title>/, `<title>${escapeHtml(title)} · LocalLens</title>`)
      .replace('</head>', `    ${tags}\n  </head>`);
    res.setHeader('Cache-Control', 'no-cache');
    res.type('html').send(page);
  };
}
