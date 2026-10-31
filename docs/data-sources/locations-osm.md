# Places from OpenStreetMap

The quickest way to fill in districts, mandals and villages is OpenStreetMap, the same data shown on our maps. (The
official LGD list is described in [locations-lgd.md](locations-lgd.md); it needs a manual download.)

```bash
npm run locations:import-osm -- --state "Andhra Pradesh" --te "ఆంధ్రప్రదేశ్"
npm run locations:import-osm -- --state "Telangana" --te "తెలంగాణ"          # another state, same command
npm run locations:import-osm -- --state "Andhra Pradesh" --dry-run            # count only, write nothing
```

- **How it works:** one Overpass API query per district. It returns every mandal boundary (admin_level 6), then the
  villages, towns and hamlets inside each one (`place=*` points). Telugu names (`name:te`) and map positions are
  stored, so village maps open without a geocoding lookup.
- **Safe to re-run:** places are matched by name under the same parent. Existing places (typed by an admin or from
  LGD) are filled in, never duplicated, and Telugu names already set are never overwritten.
- **District splits:** if OpenStreetMap has not yet removed a mandal from its old district, the newer district (the
  higher relation id) gets it.
- **Being polite to the free servers:** queries run one at a time with pauses, and each answer is cached in
  `data/osm/<state>/` (git-ignored). An interrupted run picks up where it stopped. Delete the folder to refresh.
- **Licence:** data © OpenStreetMap contributors, under the [ODbL](https://opendatacommons.org/licenses/odbl/). Our
  maps already credit OpenStreetMap; keep that credit wherever place data is shown.
- **When the live servers are overloaded** (common): download a state file and read the districts from it instead.
  This is how Chittoor and Tirupati were imported on 31 Oct 2026 (63 mandals, 4,589 villages and towns, in seconds):
  ```bash
  curl -L -o data/osm/pbf/andhra_pradesh-latest.osm.pbf https://download.openstreetmap.fr/extracts/asia/india/andhra_pradesh-latest.osm.pbf
  python -m venv data/osm/.venv && data/osm/.venv/Scripts/python -m pip install osmium==4.3.2
  data/osm/.venv/Scripts/python scripts/osm-extract-districts.py data/osm/pbf/andhra_pradesh-latest.osm.pbf data/osm/andhra-pradesh 2022304 13997802
  npm run locations:import-osm -- --state "Andhra Pradesh" --te "ఆంధ్రప్రదేశ్" --districts "Tirupati,Chittoor"
  ```
  District relation ids are listed in `data/osm/andhra-pradesh/districts.json`. Other examples: Guntur 2022220, YSR Kadapa 2022290.
- **Search:** typing any word of a name finds it ("vadla" finds "Pedda Vadlapudi"). The exact name is listed first.
- **Limits:** villages missing from OpenStreetMap stay missing. The LGD import can add them later, linking to the same
  places by name.
