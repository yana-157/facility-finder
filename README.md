# Facility Finder

The public site searches 9,076 facilities from the project's published release. The release is dated November 22, 2026 at 06:32 UTC. The team assessed service evidence for 18 services as of November 22. Both dates are recorded in `data.json`. Result cards distinguish reported bed counts from model estimates.

Search for a care service by Indian PIN, city, district, or coordinates. Recommended combines TravelTime's estimated weekday-morning drive with service match and branch-specific evidence. A successful search includes branches reached within three hours. When routing fails, the page labels its straight-line fallback. The routine-care load option compares published demand and modeled throughput when the first recommendation has a comparable nearby alternative.

The browser resolves the origin and sends its coordinates, selected service, and snapshot checksum to the public Facility Finder routing endpoint on Cloudflare Workers. The Worker keeps the TravelTime credentials server-side and returns driving times for reachable branches. Visitors can search without an account. Route calculation time and the facility evidence date are displayed separately. [Published data and prototype](https://github.com/augustchu/datathon-F26/tree/restore-care-finder-map)

## Preview and rebuild

Run `python3 -m http.server 8000` in this directory to preview. Run `node --test` to check the ranking logic. To regenerate `data.json`, use the team repository's `restore-care-finder-map` checkout at `ed9d1a8` with pandas and NumPy installed.

```sh
python3 build_data.py /path/to/datathon-F26
```

## Use Databricks as the data source

Databricks can prepare the publication-ready `data.json` feed and write it to a dedicated Unity Catalog volume. The feed uses the same structure as the checked-in `data.json`, including the source link and its preparation time. Publish only fields approved for public use. The Pages workflow downloads this file and includes it in the site build.

1. Have the workspace administrator give a dedicated service principal read access to that volume. Configure GitHub Actions OIDC for `yana-157/facility-finder` on `refs/heads/main`. [Databricks workload identity setup](https://docs.databricks.com/aws/en/dev-tools/auth/provider-github)
2. Set the Actions repository variables `DATABRICKS_HOST` to the workspace URL, `DATABRICKS_CLIENT_ID` to the service principal application ID, and `DATABRICKS_PAGES_SNAPSHOT` to the approved `/Volumes/<catalog>/<schema>/<volume>/data.json` path.
3. After the Databricks job finishes writing the feed, run **Publish Facility Finder** on `main` with **sync_databricks** enabled. Subsequent runs use the configured Databricks feed. A failed read leaves the previous Pages deployment in service. [GitHub Pages workflows](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)

When updating the snapshot, rebuild the routing backend's destination index from the exact same file. Pages runs the unit tests and a live Jaipur dialysis route check against the artifact before deploying. Run `node scripts/check-driving-ranking.mjs data.json` to repeat the check against the public routing backend.
