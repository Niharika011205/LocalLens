import { Router } from 'express';
import mongoose, { Types } from 'mongoose';
import sharp from 'sharp';
import { v2 as cloudinary } from 'cloudinary';
import { ObjectIdString, PHOTO_MAX_BYTES } from '@locallens/contracts';
import { AppError, Errors } from '../../lib/errors';
import { ArticleModel } from '../publishing/article.model';

/**
 * Photos for posts.
 *
 * Where they are kept:
 * - Cloudinary (CLOUDINARY_URL set): public, fast CDN delivery to every reader; resized and served in the best
 *   format for each phone (f_auto, q_auto).
 * - Otherwise MongoDB GridFS: no extra service, included in database backups (development and fallback).
 *
 * Every upload is first decoded and re-encoded here: this rejects anything that is not really a picture, applies the
 * phone's rotation, shrinks it, and DROPS ALL METADATA — phone photos often carry the exact GPS location. Only the
 * cleaned image ever leaves the server.
 */

const MAX_SIDE = 1280;
const MAX_INPUT_PIXELS = 40_000_000; // refuses "decompression bombs" (tiny files that expand to huge images)

export type StoredPhoto = { kind: 'gridfs'; id: Types.ObjectId } | { kind: 'cloudinary'; url: string; publicId: string };

/** Uploads a cleaned image to Cloudinary. Replaceable in tests. */
export type CloudUploader = (image: Buffer, opts: { folder: string }) => Promise<{ secure_url: string; public_id: string }>;

let store: { uploader: CloudUploader; destroy: (publicId: string) => Promise<void>; folder: string } | null = null;

/** Called at startup. With a CLOUDINARY_URL ("cloudinary://key:secret@cloud") photos go to Cloudinary. */
export function configureMedia(opts: { cloudinaryUrl?: string | undefined; folder: string; uploader?: CloudUploader; destroy?: (publicId: string) => Promise<void> }): void {
  if (!opts.cloudinaryUrl && !opts.uploader) {
    store = null;
    return;
  }
  if (opts.cloudinaryUrl) {
    const u = new URL(opts.cloudinaryUrl);
    cloudinary.config({ cloud_name: u.hostname, api_key: decodeURIComponent(u.username), api_secret: decodeURIComponent(u.password), secure: true });
  }
  store = {
    folder: opts.folder,
    uploader:
      opts.uploader ??
      ((image, { folder }) =>
        new Promise((resolve, reject) => {
          cloudinary.uploader
            .upload_stream({ folder, resource_type: 'image', overwrite: false, unique_filename: true }, (err, result) => (err || !result ? reject(err ?? new Error('upload failed')) : resolve(result)))
            .end(image);
        })),
    destroy: opts.destroy ?? (async (publicId) => void (await cloudinary.uploader.destroy(publicId, { invalidate: true }))),
  };
}
export const usingCloudinary = () => store !== null;

const bucket = () => new mongoose.mongo.GridFSBucket(mongoose.connection.db!, { bucketName: 'media' });

const notAPhoto = () => new AppError(400, 'VALIDATION_FAILED', 'The photo could not be read', [{ path: 'photo', message: 'Use a JPEG, PNG or WebP photo' }]);

async function clean(input: Buffer): Promise<Buffer> {
  if (input.length > PHOTO_MAX_BYTES) throw new AppError(413, 'PAYLOAD_TOO_LARGE', 'The photo is too large (max 8 MB)');
  try {
    const image = sharp(input, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' });
    const meta = await image.metadata();
    if (!meta.format || !['jpeg', 'png', 'webp'].includes(meta.format)) throw notAPhoto();
    // .rotate() applies the EXIF orientation; sharp writes no metadata unless asked to, so GPS/camera data is gone.
    return await image.rotate().resize({ width: MAX_SIDE, height: MAX_SIDE, fit: 'inside', withoutEnlargement: true }).webp({ quality: 82 }).toBuffer();
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw notAPhoto();
  }
}

/** Validates, cleans and stores a photo. */
export async function storePhoto(input: Buffer, uploadedBy: Types.ObjectId): Promise<StoredPhoto> {
  const output = await clean(input);
  if (store) {
    try {
      const res = await store.uploader(output, { folder: store.folder });
      // Delivery URL: auto format/quality, capped width — light on mobile data, sharp on big screens.
      return { kind: 'cloudinary', url: res.secure_url.replace('/upload/', '/upload/f_auto,q_auto,c_limit,w_1280/'), publicId: res.public_id };
    } catch {
      throw new AppError(503, 'SERVICE_UNAVAILABLE', 'The photo could not be uploaded right now. Try again, or post without a photo.');
    }
  }
  const id = new Types.ObjectId();
  await new Promise<void>((resolve, reject) => {
    const stream = bucket().openUploadStreamWithId(id, `${id.toHexString()}.webp`, { metadata: { contentType: 'image/webp', uploadedBy } });
    stream.once('finish', () => resolve());
    stream.once('error', reject);
    stream.end(output);
  });
  return { kind: 'gridfs', id };
}

/** Removes a photo for good (author deleted the post, or an editor kept it removed). */
export async function deletePhoto(article: { imageId?: Types.ObjectId | null; imagePublicId?: string | null }): Promise<void> {
  if (article.imagePublicId && store) await store.destroy(article.imagePublicId).catch(() => undefined);
  if (article.imageId) await bucket().delete(article.imageId).catch(() => undefined);
}

/** Article fields for a stored photo. */
export const photoFields = (p: StoredPhoto | null) =>
  !p ? { imageId: null, imageUrl: null, imagePublicId: null } : p.kind === 'gridfs' ? { imageId: p.id, imageUrl: null, imagePublicId: null } : { imageId: null, imageUrl: p.url, imagePublicId: p.publicId };

export const photoUrl = (id: Types.ObjectId | null | undefined) => (id ? `/api/v1/media/${id.toHexString()}` : null);

/**
 * GET /media/:id — GridFS photos. Only photos of published articles; held or removed ones only for their author and
 * editors. Short public caching so a removal takes effect within the hour. (Cloudinary photos are served by Cloudinary.)
 */
export function mediaRouter(): Router {
  const r = Router();
  r.get('/:id', async (req, res) => {
    const id = new Types.ObjectId(ObjectIdString.parse(req.params.id));
    const article = await ArticleModel.findOne({ imageId: id }, { status: 1, createdBy: 1 }).lean();
    const viewer = req.auth?.user;
    const isPublic = article?.status === 'published';
    // Held or removed: only its author and editors (who decide on it) can still see the photo.
    const privileged = !!viewer && (!!article?.createdBy.equals(viewer._id) || viewer.roles.some((r) => r === 'editor' || r === 'senior_editor' || r === 'admin'));
    if (!article || (!isPublic && !privileged) || article.status === 'retracted') throw Errors.notFound('Photo not found');
    const [file] = await bucket().find({ _id: id }).limit(1).toArray();
    if (!file) throw Errors.notFound('Photo not found');
    res.setHeader('Content-Type', 'image/webp');
    res.setHeader('Content-Length', String(file.length));
    res.setHeader('Cache-Control', isPublic ? 'public, max-age=3600' : 'private, no-store');
    bucket()
      .openDownloadStream(id)
      .on('error', () => res.destroy())
      .pipe(res);
  });
  return r;
}
