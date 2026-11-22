# Facility Finder

> **Frozen as of November 22, 2026.** The GitHub Pages demo uses the checked-in `data.json` snapshot. Searches run in the browser.

Search for a care service by Indian PIN, city, district, or coordinates. Recommended orders facilities by straight-line distance, service match, and branch-specific evidence confidence. The routine-care load option compares published demand and modeled throughput when the first recommendation has a comparable nearby alternative. Results and map pins share the same order.

The public app uses data already published by the Datathon team. Search inputs are evaluated in the browser. Databricks credentials and the underlying workspace tables stay in the workspace and build environment. [Published data and prototype](https://github.com/augustchu/datathon-F26/tree/restore-care-finder-map)

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

This updates the public snapshot on deployment. Per-search Databricks queries or live changes between deployments require an authenticated server API.
