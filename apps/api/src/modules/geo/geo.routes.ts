import { Router } from 'express';
import { placeMap } from './geocode';
import {
  CreateLocationRequest,
  ListLocationsQuery,
  ObjectIdString,
  SearchLocationsQuery,
  UpdateLocationRequest,
  type LocationListResponse,
  type LocationResponse,
  type LocationMapResponse,
} from '@locallens/contracts';
import { currentUser, requireRole } from '../../middleware/auth';
import { audit } from '../audit/audit';
import { createLocation, getLocationOrThrow, listChildren, locationDetail, searchLocations, toSummaries, updateLocation } from './geo.service';

/** Public: browse, search and view locations. */
export function locationsRouter(): Router {
  const r = Router();

  r.get('/', async (req, res) => {
    const { parentId } = ListLocationsQuery.parse(req.query);
    res.json({ items: await listChildren(parentId) } satisfies LocationListResponse);
  });

  r.get('/search', async (req, res) => {
    const { q, limit } = SearchLocationsQuery.parse(req.query);
    res.json({ items: await searchLocations(q, limit) } satisfies LocationListResponse);
  });

  r.get('/:id/map', async (req, res) => {
    const loc = await getLocationOrThrow(ObjectIdString.parse(req.params.id));
    const [summary] = await toSummaries([loc]);
    res.json((await placeMap(loc, summary?.label ?? loc.name.en)) satisfies LocationMapResponse);
  });

  r.get('/:id', async (req, res) => {
    const loc = await getLocationOrThrow(ObjectIdString.parse(req.params.id));
    res.json({ location: await locationDetail(loc) } satisfies LocationResponse);
  });

  return r;
}

/** Admin: maintain the hierarchy. */
export function adminLocationsRouter(): Router {
  const r = Router();
  r.use(requireRole('admin'));

  r.post('/', async (req, res) => {
    const input = CreateLocationRequest.parse(req.body);
    const actor = currentUser(req);
    const loc = await createLocation(input, actor._id);
    await audit(req, { action: 'geo.location_created', actorId: actor._id, targetType: 'location', targetId: loc.id, metadata: { level: loc.level, name: loc.name.en } });
    res.status(201).json({ location: await locationDetail(loc) } satisfies LocationResponse);
  });

  r.patch('/:id', async (req, res) => {
    const input = UpdateLocationRequest.parse(req.body);
    const actor = currentUser(req);
    const loc = await updateLocation(ObjectIdString.parse(req.params.id), input);
    await audit(req, { action: 'geo.location_updated', actorId: actor._id, targetType: 'location', targetId: loc.id, metadata: { fields: Object.keys(input) } });
    res.json({ location: await locationDetail(loc) } satisfies LocationResponse);
  });

  return r;
}
