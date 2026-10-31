import mongoose from 'mongoose';
import { AssistantCacheModel } from './modules/assistant/assistant';
import { AuditEventModel } from './modules/audit/audit';
import { NotificationModel } from './modules/notifications/notifications';
import { CategoryModel, ensureCategories } from './modules/catalog/catalog';
import { FollowModel, SavedArticleModel } from './modules/engagement/engagement';
import { LocationModel } from './modules/geo/location.model';
import { MfaChallengeModel, SessionModel, UserModel } from './modules/identity/models';
import { ArticleModel, ArticleRevisionModel } from './modules/publishing/article.model';
import { ContentReportModel } from './modules/moderation/reports';
import { JobModel } from './modules/jobs/jobs';
import { VerificationReportModel } from './modules/verification/verification';
import { PublisherOrgModel } from './modules/newsroom/publishers';
import { AppealModel, EditorialEventModel, SubmissionModel, SubmissionVersionModel } from './modules/newsroom/submission.model';

// Unknown fields in query filters are dropped instead of being passed to MongoDB.
mongoose.set('strictQuery', true);

export async function connectDatabase(uri: string): Promise<void> {
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10_000 });
  // Build declared indexes (unique keys, TTLs, text search) before serving traffic; correctness depends on them.
  await Promise.all(
    [
      UserModel,
      SessionModel,
      MfaChallengeModel,
      AuditEventModel,
      LocationModel,
      CategoryModel,
      ArticleModel,
      ArticleRevisionModel,
      FollowModel,
      SavedArticleModel,
      SubmissionModel,
      SubmissionVersionModel,
      EditorialEventModel,
      AppealModel,
      PublisherOrgModel,
      ContentReportModel,
      JobModel,
      VerificationReportModel,
      AssistantCacheModel,
      NotificationModel,
    ].map(
      (m) => m.init(),
    ),
  );
  await ensureCategories();
  // Phase 7 added queueAt (queue order). Older submissions sort by their submission time.
  await SubmissionModel.updateMany({ submittedAt: { $ne: null }, queueAt: null }, [{ $set: { queueAt: '$submittedAt' } }]);
}

export async function isDatabaseReady(): Promise<boolean> {
  const db = mongoose.connection.db;
  if (mongoose.connection.readyState !== 1 || !db) return false;
  await db.admin().ping();
  return true;
}

export function disconnectDatabase(): Promise<void> {
  return mongoose.disconnect();
}
