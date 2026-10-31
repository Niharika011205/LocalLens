import { Router } from 'express';
import { Schema, Types, model, type HydratedDocument } from 'mongoose';
import {
  AnnouncementRequest,
  AssignPublisherRequest,
  ObjectIdString,
  PUBLISHER_STATUSES,
  SavePublisherOrgRequest,
  type AnnouncementResponse,
  type PublisherOrg as PublisherOrgDto,
} from '@locallens/contracts';
import { AppError, Errors } from '../../lib/errors';
import { currentUser, requireRole } from '../../middleware/auth';
import { audit } from '../audit/audit';
import { CategoryModel, toCategory } from '../catalog/catalog';
import { toSummaries } from '../geo/geo.service';
import { LocationModel } from '../geo/location.model';
import { UserModel, toPublicUser } from '../identity/models';
import { createArticle, toArticleSummaries } from '../publishing/articles.service';
import { screenRisk } from './risk';
import { EditorialEventModel, SubmissionModel } from './submission.model';

interface PublisherOrgRecord {
  name: string;
  status: (typeof PUBLISHER_STATUSES)[number];
  jurisdictionIds: Types.ObjectId[];
  allowedCategoryIds: Types.ObjectId[];
  officialDomains: string[];
  createdAt: Date;
  updatedAt: Date;
}
type PublisherOrgDoc = HydratedDocument<PublisherOrgRecord>;

const orgSchema = new Schema<PublisherOrgRecord>(
  {
    name: { type: String, required: true, unique: true },
    status: { type: String, enum: PUBLISHER_STATUSES, required: true },
    jurisdictionIds: { type: [Schema.Types.ObjectId], default: [] },
    allowedCategoryIds: { type: [Schema.Types.ObjectId], default: [] },
    officialDomains: { type: [String], default: [] },
  },
  { timestamps: true },
);
export const PublisherOrgModel = model<PublisherOrgRecord>('PublisherOrg', orgSchema, 'publisher_orgs');

async function toDto(org: PublisherOrgDoc): Promise<PublisherOrgDto> {
  const [locations, categories, memberCount] = await Promise.all([
    LocationModel.find({ _id: { $in: org.jurisdictionIds } }),
    CategoryModel.find({ _id: { $in: org.allowedCategoryIds } }).sort({ sortOrder: 1 }),
    UserModel.countDocuments({ publisherOrgId: org._id }),
  ]);
  return {
    id: org.id as string,
    name: org.name,
    status: org.status,
    jurisdictions: await toSummaries(locations),
    allowedCategories: categories.map(toCategory),
    officialDomains: [...org.officialDomains],
    memberCount,
  };
}

/** A link counts as official only if its host is one of the organisation's registered domains (or a subdomain). */
export function isOfficialUrl(url: string, domains: string[]): boolean {
  let host: string;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    host = u.hostname.toLowerCase();
  } catch {
    return false;
  }
  return domains.some((d) => host === d || host.endsWith(`.${d}`));
}

/** Admin: onboard organisations and attach publisher accounts to them. */
export function adminPublishersRouter(): Router {
  const r = Router();
  r.use(requireRole('admin'));

  const validate = async (input: SavePublisherOrgRequest) => {
    const [locs, cats] = await Promise.all([
      LocationModel.countDocuments({ _id: { $in: input.jurisdictionIds } }),
      CategoryModel.countDocuments({ _id: { $in: input.allowedCategoryIds } }),
    ]);
    if (locs !== new Set(input.jurisdictionIds).size) throw new AppError(400, 'VALIDATION_FAILED', 'Unknown jurisdiction');
    if (cats !== new Set(input.allowedCategoryIds).size) throw new AppError(400, 'VALIDATION_FAILED', 'Unknown category');
  };

  r.get('/publishers', async (_req, res) => {
    const orgs = await PublisherOrgModel.find().sort({ name: 1 });
    res.json({ items: await Promise.all(orgs.map(toDto)) });
  });

  r.post('/publishers', async (req, res) => {
    const input = SavePublisherOrgRequest.parse(req.body);
    await validate(input);
    try {
      const org = await PublisherOrgModel.create(input);
      await audit(req, { action: 'publisher.org_created', actorId: currentUser(req)._id, targetType: 'publisher_org', targetId: org.id, metadata: { status: org.status } });
      res.status(201).json({ org: await toDto(org) });
    } catch (err) {
      if ((err as { code?: number }).code === 11000) throw Errors.conflict('An organisation with this name already exists');
      throw err;
    }
  });

  r.put('/publishers/:id', async (req, res) => {
    const input = SavePublisherOrgRequest.parse(req.body);
    await validate(input);
    const org = await PublisherOrgModel.findByIdAndUpdate(ObjectIdString.parse(req.params.id), { $set: input }, { new: true });
    if (!org) throw Errors.notFound('Organisation not found');
    await audit(req, { action: 'publisher.org_updated', actorId: currentUser(req)._id, targetType: 'publisher_org', targetId: org.id, metadata: { status: org.status } });
    res.json({ org: await toDto(org) });
  });

  r.put('/users/:id/publisher', async (req, res) => {
    const { orgId } = AssignPublisherRequest.parse(req.body);
    if (orgId && !(await PublisherOrgModel.exists({ _id: orgId }))) throw Errors.notFound('Organisation not found');
    const user = await UserModel.findByIdAndUpdate(ObjectIdString.parse(req.params.id), { $set: { publisherOrgId: orgId ? new Types.ObjectId(orgId) : null } }, { new: true });
    if (!user) throw Errors.notFound('User not found');
    await audit(req, { action: 'publisher.member_assigned', actorId: currentUser(req)._id, targetType: 'user', targetId: user.id, metadata: { orgId } });
    res.json({ user: toPublicUser(user) });
  });

  return r;
}

/**
 * Publishers: the hybrid publication policy. An announcement goes live immediately only if EVERY check passes;
 * otherwise it is not rejected but routed to editorial review, with the reasons recorded. A verified organisation is
 * not proof that a statement is true, so direct publications carry the "Official source — not independently
 * verified" label and a mandatory link to the original document.
 */
export function publisherRouter(): Router {
  const r = Router();
  r.use(requireRole('publisher'));

  r.get('/me', async (req, res) => {
    const user = currentUser(req);
    const org = user.publisherOrgId ? await PublisherOrgModel.findById(user.publisherOrgId) : null;
    res.json({ org: org ? await toDto(org) : null });
  });

  r.post('/announcements', async (req, res) => {
    const input = AnnouncementRequest.parse(req.body);
    const user = currentUser(req);
    const org = user.publisherOrgId ? await PublisherOrgModel.findById(user.publisherOrgId) : null;
    if (!org) throw Errors.forbidden('Your account is not linked to a verified organisation');
    const [location, category] = await Promise.all([LocationModel.findById(input.locationId), CategoryModel.findById(input.categoryId)]);
    if (!location) throw new AppError(400, 'VALIDATION_FAILED', 'Unknown location', [{ path: 'locationId', message: 'Unknown location' }]);
    if (!category) throw new AppError(400, 'VALIDATION_FAILED', 'Unknown category', [{ path: 'categoryId', message: 'Unknown category' }]);

    const reasons: string[] = [];
    if (org.status !== 'active') reasons.push('organisation_not_active');
    if (!org.allowedCategoryIds.some((c) => c.equals(category._id))) reasons.push('category_not_allowed');
    const lineage = [location._id, ...location.ancestorIds];
    if (!lineage.some((l) => org.jurisdictionIds.some((j) => j.equals(l)))) reasons.push('outside_jurisdiction');
    if (!isOfficialUrl(input.originalSourceUrl, org.officialDomains)) reasons.push('source_not_official_domain');
    const risk = screenRisk(`${input.headline} ${input.summary} ${input.body}`, category.slug);
    if (risk.level === 'high') reasons.push('high_risk_content');

    const deadline = input.deadline ? new Date(`${input.deadline}T00:00:00Z`) : null;
    if (reasons.length === 0) {
      const article = await createArticle(
        { ...input, trustLabel: 'official_unverified', sourceType: 'official_publisher' },
        user._id,
        { publisherOrgId: org._id, deadline },
      );
      await audit(req, { action: 'publisher.direct_published', actorId: user._id, targetType: 'article', targetId: article.id, metadata: { orgId: org.id } });
      res.status(201).json({ outcome: 'published', article: (await toArticleSummaries([article]))[0]! } satisfies AnnouncementResponse);
      return;
    }

    const sub = await SubmissionModel.create({
      reporterId: user._id,
      origin: 'publisher',
      status: 'submitted',
      version: 1,
      headline: input.headline,
      summary: input.summary,
      body: input.body,
      language: input.language,
      locationId: location._id,
      locationLineage: lineage,
      districtId: (await LocationModel.findOne({ _id: { $in: lineage }, level: 'district' }, { _id: 1 }))?._id ?? null,
      categoryId: category._id,
      supportingUrls: [input.originalSourceUrl],
      originalSourceUrl: input.originalSourceUrl,
      deadline,
      riskLevel: risk.level,
      riskRank: risk.level === 'high' ? 1 : 0,
      riskReasons: risk.reasons,
      submittedAt: new Date(),
      queueAt: new Date(),
    });
    await EditorialEventModel.create({
      submissionId: sub._id,
      actorId: null,
      actorRole: 'system',
      action: 'routed_to_review',
      fromStatus: null,
      toStatus: 'submitted',
      reasonCode: reasons.join(','),
      note: `Sent for editorial review: ${reasons.join(', ')}`,
      visibleToReporter: true,
    });
    await audit(req, { action: 'publisher.routed_to_review', actorId: user._id, targetType: 'submission', targetId: sub.id, metadata: { orgId: org.id, reasons } });
    res.status(202).json({ outcome: 'sent_for_review', submissionId: sub.id as string, reasons } satisfies AnnouncementResponse);
  });

  return r;
}
