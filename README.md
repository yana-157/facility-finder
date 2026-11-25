# Facility Finder

The [Data and methods report](https://yana-157.github.io/facility-finder/methods.html) follows the facility records from the source release through branch review, capacity experiments, search design and live routing checks. The report is served alongside the [public finder](https://yana-157.github.io/facility-finder/).

The public site searches 9,076 facilities from the project's published release. The release is dated November 22, 2026 at 06:32 UTC. The team assessed service evidence for 18 services as of November 22. The facility count and both dates from `data.json` appear beneath the page title. Result cards distinguish reported bed counts from model estimates.

Search for a care service by Indian PIN, city, district, or coordinates. Under **Options**, choose driving, walking, cycling, or public transport. Open **Results and fit settings** in the same panel to change the number of results or adjust the Fit-score weights. The app automatically requests TravelTime estimates for your choice. A successful search considers branches reachable within three hours on a typical weekday morning. All sorts require service confidence of at least 25 and exclude calculated Fit scores of zero. Recommended shows four Fit groups in descending order (60+, 55 to under 60, 50 to under 55, and positive scores below 50). Within each group, a shorter trip and stronger branch-specific evidence improve rank. Service match contributes through Fit. Fastest ranks by journey time and can include branches with unknown Fit. Public transport coverage varies by location. When routing fails, the page labels its straight-line fallback. For routine care, turn on **Ease pressure on busy facilities** to compare published demand and modeled throughput at comparable nearby branches in the same Fit group. The comparison applies to Recommended sorting.

The browser resolves the origin and sends its coordinates, selected service, travel mode, and snapshot checksum to the public Facility Finder routing endpoint on Cloudflare Workers. The Worker keeps the TravelTime credentials server-side and returns journey times for reachable branches. Visitors can search without an account. Route calculation time and the facility evidence date are displayed separately. [Published data and prototype](https://github.com/augustchu/datathon-F26/tree/restore-care-finder-map)

## Preview and rebuild

Run `python3 -m http.server 8000` in this directory to preview. Run `node --test` to check the ranking logic. To regenerate `data.json`, use the team repository's `restore-care-finder-map` checkout at `ed9d1a8` with pandas and NumPy installed.

```sh
python3 build_data.py /path/to/datathon-F26
python3 build_classic_data.py /path/to/datathon-F26
```

## Replay the dialysis comparison offline

Use Node 24 or later from a Git checkout containing the archived commit. The replay reads both the November 22 data and the ranker used for the original workload experiment from that revision. It compares the branches at a fixed origin using straight-line kilometres. That version predates the current Fit tiers and confidence floor. [Archived ranker and snapshot](https://github.com/yana-157/facility-finder/tree/a5820e0e9acb34d61566f34de91238ab3a63ca05)

```sh
node --input-type=module <<'JS'
import {execFileSync} from 'node:child_process';

const revision = 'a5820e0e9acb34d61566f34de91238ab3a63ca05';
function archivedFile(name) {
  return execFileSync('git', ['show', revision + ':' + name], {maxBuffer: 32 * 1024 * 1024});
}
const source = archivedFile('ranking.js').toString('base64');
const {rankFacilities} = await import('data:text/javascript;base64,' + source);
const snapshot = JSON.parse(archivedFile('data.json').toString('utf8'));
const query = {service: 'Dialysis', origin: {lat: 31.833, lon: 77.018}, severity: 'routine', limit: 2};
for (const considerLoad of [false, true]) {
  const {results} = rankFacilities(snapshot, {...query, considerLoad});
  console.table(results.map(({facility, distanceKm}, index) => ({
    considerLoad, rank: index + 1, branch: facility.name, km: distanceKm.toFixed(2),
  })));
}
JS
```

Mandi ranks first at 16.02 km in the baseline. Kullu ranks first at 16.34 km when the comparison includes the branches’ projected dialysis workload.

## Use Databricks as the data source

Databricks can prepare the publication-ready `data.json` feed and write it to a dedicated Unity Catalog volume. The feed uses the same structure as the checked-in `data.json`, including the source link and its preparation time. Publish only fields approved for public use. The Pages workflow downloads this file and includes it in the site build.

1. Have the workspace administrator give a dedicated service principal read access to that volume. Configure GitHub Actions OIDC for `yana-157/facility-finder` on `refs/heads/main`. [Databricks workload identity setup](https://docs.databricks.com/aws/en/dev-tools/auth/provider-github)
2. Set the Actions repository variables `DATABRICKS_HOST` to the workspace URL, `DATABRICKS_CLIENT_ID` to the service principal application ID, and `DATABRICKS_PAGES_SNAPSHOT` to the approved `/Volumes/<catalog>/<schema>/<volume>/data.json` path.
3. After the Databricks job finishes writing the feed, run **Publish Facility Finder** on `main` with **sync_databricks** enabled. Subsequent runs use the configured Databricks feed. A failed read leaves the previous Pages deployment in service. [GitHub Pages workflows](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)

When updating the snapshot, rebuild the companion facility details and routing destination index from the exact same file. The companion carries the source checksum and the service taxonomy used by the restored search controls. If the snapshot and companion differ, publication stops. Before deploying, Pages checks the fastest and recommended dialysis rankings for driving, walking, and cycling in Jaipur and for public transport in Mumbai. Run `node scripts/check-travel-ranking.mjs data.json` to repeat these searches against the public routing backend.
