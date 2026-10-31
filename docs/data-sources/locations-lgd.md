# Location data source — Local Government Directory (LGD)

Status: **Importer ready for all of India (tested at 30,000 villages in ~7 s ⇒ ~6.5 lakh in a few minutes). The official
file must be downloaded by a person (the LGD portal uses a CAPTCHA, which we do not automate around).**

## Importing every village in India (one-time, ~10 minutes)
1. Open https://lgdirectory.gov.in/downloadDirectory.do → **All Villages of India** → choose **CSV** if offered (otherwise
   Excel, then in Excel *File → Save As → CSV UTF-8*). Solve the CAPTCHA and download.
2. Save it as `data/lgd/all-villages-of-india.csv` (git-ignored) and note the date, URL and SHA-256 in `data/lgd/MANIFEST.md`.
3. Run (with the app's database; for `npm run dev:standalone` that is `mongodb://127.0.0.1:27019/locallens`):
   `MONGODB_URI=… npm run locations:import -- --file data/lgd/all-villages-of-india.csv --dry-run` — check the counts, then
   run it again without `--dry-run`. Add `--state 28` to import one state (28 = Andhra Pradesh).
4. Re-run with a newer file at any time: existing places are kept (matched by LGD code), new ones added.

How names are stored: English names from LGD; the local-language name becomes the Telugu name when it is written in
Telugu script, otherwise (Hindi, Tamil, Bengali…) it is kept as a searchable alternative name. Two villages with the
same name in one mandal are both kept.

## Maps
Place pages show a map (OpenStreetMap via Leaflet) and an "Open in Google Maps" link. Positions come from OpenStreetMap
Nominatim: one lookup per place on first view, at most one request per second, cached in the database. We do not copy
data from Google Maps: its terms do not allow storing its places, and it is paid per request. For heavy production
traffic, use a hosted tile/geocoding provider (e.g. MapTiler, Stadia, LocationIQ) via `GEOCODER_URL` and the tile URL.

## Why LGD
The Local Government Directory, run by India's Ministry of Panchayati Raj, assigns official codes to states,
districts, sub-districts (mandals in Andhra Pradesh) and villages, and tracks changes to them. Using LGD codes means:
- we never invent identifiers or names;
- data can be joined with other government datasets that use the same codes;
- later reorganisations can be imported as changes, not re-typed by hand.

## Sources, in order of preference

| # | Source | Notes |
|---|---|---|
| 1 | **lgdirectory.gov.in → Download Directory** (`https://lgdirectory.gov.in/downloadDirectory.do`) | Official primary source. Offers downloads such as villages of a sub-district or all villages of a state. The exact steps (and whether a CAPTCHA is required) must be checked by a person; we do not automate around CAPTCHAs. |
| 2 | **Open Government Data platform (data.gov.in)** — datasets "Local Government Directory (LGD) – Villages" and "– Sub-Districts" | Official mirror, reportedly refreshed monthly. Village records include a local-language name field (`villageNameLocal`) and Census 2011 codes. |
| 3 | Community mirrors (e.g. `github.com/planemad/india-local-government-directory`, `ramseraph.github.io/opendata/lgd/`) | Convenient CSV dumps under the Government Open Data License – India, but third-party and possibly out of date. **Only for cross-checking**, never as the system of record. |

Licence: Government Open Data License – India (GODL-India), which permits reuse with attribution. Attribution text will
be shown on the app's "About / Data sources" page.

## Import procedure (Phase 2)
1. A person downloads the Andhra Pradesh sub-district and village files from source 1 (or 2) and records the
   download date, URL and SHA-256 checksum in `data/lgd/MANIFEST.md`.
2. `npm run locations:import -- --file <path> --district-lgd <code>` validates the file (required columns, unique codes,
   every child's parent exists) and upserts by `(level, lgdCode)`. It is idempotent: re-running it changes nothing.
3. Units missing from a newer file are **closed** (`validTo` set), never deleted.
4. Every imported document stores `source: { dataset, version, importedAt }`.
5. The import prints a summary (created / updated / closed) that is reviewed before running in production.

## Known caveats to check during import
- Andhra Pradesh reorganised its districts in **2022**; parts of the former Guntur district now belong to other
  districts. Old names must become aliases, and residents may still use the old district name (pilot assumption P7).
- Local-language (Telugu) names may be missing or spelled inconsistently for some villages; gaps are listed for review
  by local contributors rather than filled in by guesswork.
- Urban areas (municipal corporations, municipalities, wards) are modelled separately in LGD as local bodies. Whether the
  pilot needs ward-level locations is an open question for user research.
