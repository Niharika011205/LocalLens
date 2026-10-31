import { Router } from 'express';
import { Schema, Types, model } from 'mongoose';
import {
  FeedQuery,
  FOLLOW_TARGETS,
  FollowTarget,
  ObjectIdString,
  type ArticleListResponse,
  type FollowsResponse,
  type SavedListResponse,
  type SavedStatusResponse,
} from '@locallens/contracts';
import { Errors } from '../../lib/errors';
import { currentUser, requireAuth } from '../../middleware/auth';
import { CategoryModel, toCategory } from '../catalog/catalog';
import { toSummaries } from '../geo/geo.service';
import { LocationModel } from '../geo/location.model';
import { ArticleModel } from '../publishing/article.model';
import { followedFeed, toArticleSummaries } from '../publishing/articles.service';

// ---------- models ----------
interface Follow {
  userId: Types.ObjectId;
  targetType: FollowTarget;
  targetId: Types.ObjectId;
  createdAt: Date;
}
const followSchema = new Schema<Follow>(
  {
    userId: { type: Schema.Types.ObjectId, required: true },
    targetType: { type: String, enum: FOLLOW_TARGETS, required: true },
    targetId: { type: Schema.Types.ObjectId, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
followSchema.index({ userId: 1, targetType: 1, targetId: 1 }, { unique: true });
followSchema.index({ targetType: 1, targetId: 1 }); // who follows this place/topic (notification fan-out)
export const FollowModel = model<Follow>('Follow', followSchema, 'follows');

interface SavedArticle {
  userId: Types.ObjectId;
  articleId: Types.ObjectId;
  createdAt: Date;
}
const savedSchema = new Schema<SavedArticle>(
  {
    userId: { type: Schema.Types.ObjectId, required: true },
    articleId: { type: Schema.Types.ObjectId, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
savedSchema.index({ userId: 1, articleId: 1 }, { unique: true });
savedSchema.index({ userId: 1, createdAt: -1 });
savedSchema.index({ articleId: 1 }); // who saved this article (correction and deadline alerts)
export const SavedArticleModel = model<SavedArticle>('SavedArticle', savedSchema, 'saved_articles');

const MAX_FOLLOWS = 50;
const MAX_SAVED = 500;

// ---------- routes (all under /me, signed in) ----------
export function engagementRouter(): Router {
  const r = Router();
  r.use(requireAuth);

  r.get('/follows', async (req, res) => {
    const follows = await FollowModel.find({ userId: currentUser(req)._id }).sort({ createdAt: 1 });
    const ids = (t: FollowTarget) => follows.filter((f) => f.targetType === t).map((f) => f.targetId);
    const [locations, categories] = await Promise.all([
      LocationModel.find({ _id: { $in: ids('location') } }),
      CategoryModel.find({ _id: { $in: ids('category') } }).sort({ sortOrder: 1 }),
    ]);
    res.json({ locations: await toSummaries(locations), categories: categories.map(toCategory) } satisfies FollowsResponse);
  });

  r.put('/follows/:targetType/:targetId', async (req, res) => {
    const targetType = FollowTarget.parse(req.params.targetType);
    const targetId = new Types.ObjectId(ObjectIdString.parse(req.params.targetId));
    const exists = targetType === 'location' ? await LocationModel.exists({ _id: targetId }) : await CategoryModel.exists({ _id: targetId });
    if (!exists) throw Errors.notFound(`${targetType} not found`);
    const userId = currentUser(req)._id;
    if ((await FollowModel.countDocuments({ userId })) >= MAX_FOLLOWS) throw Errors.conflict(`You can follow at most ${MAX_FOLLOWS} places and topics`);
    // Idempotent: following twice is not an error.
    await FollowModel.updateOne({ userId, targetType, targetId }, { $setOnInsert: { userId, targetType, targetId } }, { upsert: true });
    res.status(204).end();
  });

  r.delete('/follows/:targetType/:targetId', async (req, res) => {
    const targetType = FollowTarget.parse(req.params.targetType);
    const targetId = new Types.ObjectId(ObjectIdString.parse(req.params.targetId));
    await FollowModel.deleteOne({ userId: currentUser(req)._id, targetType, targetId });
    res.status(204).end();
  });

  r.get('/feed', async (req, res) => {
    const { limit, cursor } = FeedQuery.parse(req.query);
    const follows = await FollowModel.find({ userId: currentUser(req)._id });
    const pick = (t: FollowTarget) => follows.filter((f) => f.targetType === t).map((f) => f.targetId);
    res.json((await followedFeed(pick('location'), pick('category'), limit, cursor)) satisfies ArticleListResponse);
  });

  r.get('/saved', async (req, res) => {
    const saved = await SavedArticleModel.find({ userId: currentUser(req)._id }).sort({ createdAt: -1 }).limit(100);
    // Only articles that are still public: an unpublished article silently drops out of the list.
    const articles = await ArticleModel.find({ _id: { $in: saved.map((s) => s.articleId) }, status: { $in: ['published', 'retracted'] } });
    const byId = new Map(articles.map((a) => [a.id as string, a]));
    const ordered = saved.map((s) => byId.get(String(s.articleId))).filter((a): a is NonNullable<typeof a> => !!a);
    res.json({ items: await toArticleSummaries(ordered) } satisfies SavedListResponse);
  });

  r.get('/saved/:articleId', async (req, res) => {
    const articleId = ObjectIdString.parse(req.params.articleId);
    const saved = await SavedArticleModel.exists({ userId: currentUser(req)._id, articleId });
    res.json({ saved: !!saved } satisfies SavedStatusResponse);
  });

  r.put('/saved/:articleId', async (req, res) => {
    const articleId = new Types.ObjectId(ObjectIdString.parse(req.params.articleId));
    if (!(await ArticleModel.exists({ _id: articleId, status: { $in: ['published', 'retracted'] } }))) throw Errors.notFound('Article not found');
    const userId = currentUser(req)._id;
    if ((await SavedArticleModel.countDocuments({ userId })) >= MAX_SAVED) throw Errors.conflict(`You can save at most ${MAX_SAVED} articles`);
    await SavedArticleModel.updateOne({ userId, articleId }, { $setOnInsert: { userId, articleId } }, { upsert: true });
    res.status(204).end();
  });

  r.delete('/saved/:articleId', async (req, res) => {
    await SavedArticleModel.deleteOne({ userId: currentUser(req)._id, articleId: ObjectIdString.parse(req.params.articleId) });
    res.status(204).end();
  });

  return r;
}
