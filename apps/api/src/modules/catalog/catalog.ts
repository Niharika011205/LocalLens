import { Router } from 'express';
import { Schema, model, type HydratedDocument } from 'mongoose';
import { CATEGORY_SLUGS, type Category, type CategoryListResponse, type CategorySlug } from '@locallens/contracts';

export interface CategoryRecord {
  slug: CategorySlug;
  name: { en: string; te: string };
  sortOrder: number;
}
export type CategoryDoc = HydratedDocument<CategoryRecord>;

const categorySchema = new Schema<CategoryRecord>({
  slug: { type: String, enum: CATEGORY_SLUGS, required: true, unique: true },
  name: { en: { type: String, required: true }, te: { type: String, required: true } },
  sortOrder: { type: Number, required: true },
});

export const CategoryModel = model<CategoryRecord>('Category', categorySchema, 'categories');

// The categories named in the master specification. Telugu names are drafts for native-speaker review.
const CATEGORIES: Record<CategorySlug, { en: string; te: string }> = {
  local_events: { en: 'Local events', te: 'స్థానిక కార్యక్రమాలు' },
  education: { en: 'Education', te: 'విద్య' },
  employment: { en: 'Employment', te: 'ఉపాధి' },
  agriculture: { en: 'Agriculture', te: 'వ్యవసాయం' },
  civic_issues: { en: 'Civic issues', te: 'పౌర సమస్యలు' },
  government_announcements: { en: 'Government announcements', te: 'ప్రభుత్వ ప్రకటనలు' },
  public_safety: { en: 'Public safety', te: 'ప్రజా భద్రత' },
  community_news: { en: 'Community news', te: 'సమాజ వార్తలు' },
};

/** Idempotent: creates missing categories and keeps names in sync with the code. Run at startup. */
export async function ensureCategories(): Promise<void> {
  await CategoryModel.bulkWrite(
    CATEGORY_SLUGS.map((slug, i) => ({
      updateOne: { filter: { slug }, update: { $set: { name: CATEGORIES[slug], sortOrder: i } }, upsert: true },
    })),
  );
}

export function toCategory(c: CategoryDoc): Category {
  return { id: c.id as string, slug: c.slug, name: { en: c.name.en, te: c.name.te } };
}

export function categoriesRouter(): Router {
  const r = Router();
  r.get('/', async (_req, res) => {
    const items = (await CategoryModel.find().sort({ sortOrder: 1 })).map(toCategory);
    res.json({ items } satisfies CategoryListResponse);
  });
  return r;
}
