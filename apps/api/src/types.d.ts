import type { Types } from 'mongoose';
import type { UserDoc } from './modules/identity/models';

declare global {
  namespace Express {
    interface Request {
      /** Set by the session middleware when a valid session cookie belongs to an active user. */
      auth?: { user: UserDoc; sessionId: Types.ObjectId };
    }
  }
}

export {};
