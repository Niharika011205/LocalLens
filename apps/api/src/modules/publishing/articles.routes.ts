import { Router } from 'express';
import {
  CreateArticleRequest,
  DeadlinesQuery,
  EditorialListQuery,
  FeedQuery,
  ObjectIdString,
  RetractArticleRequest,
  ReviseArticleRequest,
  SearchArticlesQuery,
  UnpublishArticleRequest,
  type ArticleListResponse,
  type ArticleResponse,
  type DeadlinesResponse,
} from '@locallens/contracts';
import { z } from 'zod';
import { currentUser, requireRole } from '../../middleware/auth';
import { audit } from '../audit/audit';
import {
  createArticle,
  editorialList,
  getArticleForEditor,
  getPublicArticle,
  publicFeed,
  retractArticle,
  reviseArticle,
  searchArticles,
  setPublished,
  toArticleDetail,
  upcomingDeadlines,
} from './articles.service';

const Slug = z.string().regex(/^[a-z0-9-]{3,80}$/, 'Invalid article');

/** Public: feed, search and article pages. Never returns unpublished articles. */
export function articlesRouter(): Router {
  const r = Router();

  r.get('/', async (req, res) => {
    const q = FeedQuery.parse(req.query);
    res.json((await publicFeed(q)) satisfies ArticleListResponse);
  });

  r.get('/search', async (req, res) => {
    const { q, limit } = SearchArticlesQuery.parse(req.query);
    res.json({ items: await searchArticles(q, limit), nextCursor: null } satisfies ArticleListResponse);
  });

  r.get('/deadlines', async (req, res) => {
    const q = DeadlinesQuery.parse(req.query);
    res.json({ items: await upcomingDeadlines(q) } satisfies DeadlinesResponse);
  });

  r.get('/:slug', async (req, res) => {
    const article = await getPublicArticle(Slug.parse(req.params.slug));
    res.json({ article: await toArticleDetail(article) } satisfies ArticleResponse);
  });

  return r;
}

/** Editors publish and maintain articles. Every action is audited; every content change is a public revision. */
export function editorialRouter(): Router {
  const r = Router();
  r.use(requireRole('editor', 'senior_editor', 'admin'));

  r.get('/articles', async (req, res) => {
    const q = EditorialListQuery.parse(req.query);
    res.json((await editorialList(q)) satisfies ArticleListResponse);
  });

  r.get('/articles/:id', async (req, res) => {
    const article = await getArticleForEditor(ObjectIdString.parse(req.params.id));
    res.json({ article: { ...(await toArticleDetail(article)), body: article.body } } satisfies ArticleResponse);
  });

  r.post('/articles', async (req, res) => {
    const input = CreateArticleRequest.parse(req.body);
    const editor = currentUser(req);
    const article = await createArticle(input, editor._id);
    await audit(req, { action: 'article.published', actorId: editor._id, targetType: 'article', targetId: article.id });
    res.status(201).json({ article: await toArticleDetail(article) } satisfies ArticleResponse);
  });

  r.post('/articles/:id/revisions', async (req, res) => {
    const input = ReviseArticleRequest.parse(req.body);
    const editor = currentUser(req);
    const article = await reviseArticle(ObjectIdString.parse(req.params.id), input, editor._id);
    await audit(req, { action: `article.${input.changeKind}`, actorId: editor._id, targetType: 'article', targetId: article.id, metadata: { revision: article.revisionCount } });
    res.json({ article: await toArticleDetail(article) } satisfies ArticleResponse);
  });

  r.post('/articles/:id/unpublish', async (req, res) => {
    const { reason } = UnpublishArticleRequest.parse(req.body);
    const editor = currentUser(req);
    const article = await setPublished(ObjectIdString.parse(req.params.id), false);
    // The reason is internal (legal holds, errors), so it goes to the audit log, not the public history.
    await audit(req, { action: 'article.unpublished', actorId: editor._id, targetType: 'article', targetId: article.id, metadata: { reason } });
    res.json({ article: { ...(await toArticleDetail(article)), body: article.body } } satisfies ArticleResponse);
  });

  r.post('/articles/:id/republish', async (req, res) => {
    const editor = currentUser(req);
    const article = await setPublished(ObjectIdString.parse(req.params.id), true);
    await audit(req, { action: 'article.republished', actorId: editor._id, targetType: 'article', targetId: article.id });
    res.json({ article: await toArticleDetail(article) } satisfies ArticleResponse);
  });

  // Retraction is the most serious action, so it needs a senior editor or an admin.
  r.post('/articles/:id/retract', requireRole('senior_editor', 'admin'), async (req, res) => {
    const { publicNote } = RetractArticleRequest.parse(req.body);
    const editor = currentUser(req);
    const article = await retractArticle(ObjectIdString.parse(req.params.id), publicNote, editor._id);
    await audit(req, { action: 'article.retracted', actorId: editor._id, targetType: 'article', targetId: article.id });
    res.json({ article: await toArticleDetail(article) } satisfies ArticleResponse);
  });

  return r;
}
