"""
Reads districts' mandals and villages from an OpenStreetMap extract (.osm.pbf, e.g. Geofabrik's daily
"southern-zone" file) and writes them in the same JSON the Overpass import caches
(data/osm/<state>/district-<relation id>.json). `npm run locations:import-osm` then imports them without the live
Overpass servers, which are often overloaded.

  python -m venv data/osm/.venv && data/osm/.venv/Scripts/python -m pip install osmium==4.3.2
  data/osm/.venv/Scripts/python scripts/osm-extract-districts.py data/osm/geofabrik/southern-zone.osm.pbf \
      data/osm/andhra-pradesh 2022304 13997802          (district relation ids: Chittoor, Tirupati)

Same rules as the Overpass query: mandals are admin_level 6 boundaries whose middle lies inside the district; places
(village, town, city, hamlet, suburb points with a name) go to the mandal whose boundary contains them.
Data © OpenStreetMap contributors, ODbL.
"""
import json
import sys
import time
from pathlib import Path

import osmium

PLACES = {'village', 'town', 'city', 'hamlet', 'suburb'}


def rings_of(area):
    rings = []
    for outer in area.outer_rings():
        rings.append([(n.lon, n.lat) for n in outer])
        for inner in area.inner_rings(outer):
            rings.append([(n.lon, n.lat) for n in inner])
    return rings


def bbox(rings):
    xs = [x for r in rings for x, _ in r]
    ys = [y for r in rings for _, y in r]
    return min(xs), min(ys), max(xs), max(ys)


def inside(x, y, rings):
    """Even-odd ray casting over every ring edge: holes (inner rings) are handled by the same rule."""
    hit = False
    for ring in rings:
        for (x1, y1), (x2, y2) in zip(ring, ring[1:] + ring[:1]):
            if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
                hit = not hit
    return hit


def middle(rings):
    """Average of the largest ring's corners: inside for mandal-shaped polygons; checked against the polygon."""
    ring = max(rings, key=len)
    return sum(x for x, _ in ring) / len(ring), sum(y for _, y in ring) / len(ring)


def main():
    if len(sys.argv) < 4:
        sys.exit(__doc__)
    pbf, out_dir, district_ids = sys.argv[1], Path(sys.argv[2]), {int(i) for i in sys.argv[3:]}
    started = time.time()
    districts, mandals, places = {}, [], []

    fp = (
        osmium.FileProcessor(pbf)
        .with_locations('sparse_mem_array')
        .with_areas(osmium.filter.TagFilter(('boundary', 'administrative')))
        .with_filter(osmium.filter.EmptyTagFilter())
    )
    for obj in fp:
        if obj.is_node():
            if obj.tags.get('place') in PLACES and 'name' in obj.tags:
                places.append({'type': 'node', 'id': obj.id, 'lat': obj.location.lat, 'lon': obj.location.lon, 'tags': dict(obj.tags)})
        elif obj.is_area() and not obj.from_way():
            level = obj.tags.get('admin_level')
            if level == '5' and obj.orig_id() in district_ids:
                districts[obj.orig_id()] = rings_of(obj)
            elif level == '6':
                try:
                    rings = rings_of(obj)
                except RuntimeError:
                    continue  # broken geometry in the source data
                if rings:
                    mandals.append({'id': obj.orig_id(), 'tags': dict(obj.tags), 'rings': rings, 'bbox': bbox(rings)})
    print(f'read the file in {time.time() - started:.0f} s: {len(places)} named places, {len(mandals)} mandal boundaries, '
          f'{len(districts)}/{len(district_ids)} districts', flush=True)

    for district_id in sorted(district_ids):
        rings = districts.get(district_id)
        if not rings:
            print(f'  district {district_id}: not found in this file', flush=True)
            continue
        own = [m for m in mandals if inside(*middle(m['rings']), rings)]
        elements = []
        claimed = set()
        for m in own:
            cx, cy = middle(m['rings'])
            elements.append({'type': 'relation', 'id': m['id'], 'center': {'lat': cy, 'lon': cx}, 'tags': m['tags']})
            x0, y0, x1, y1 = m['bbox']
            for p in places:
                if p['id'] not in claimed and x0 <= p['lon'] <= x1 and y0 <= p['lat'] <= y1 and inside(p['lon'], p['lat'], m['rings']):
                    claimed.add(p['id'])
                    elements.append(p)
        out = out_dir / f'district-{district_id}.json'
        out.write_text(json.dumps({'elements': elements}, ensure_ascii=False), encoding='utf-8')
        print(f'  district {district_id}: {len(own)} mandals, {len(claimed)} places -> {out}', flush=True)


if __name__ == '__main__':
    main()
