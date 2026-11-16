// Every number Install Check shows comes from this file. Each entry is a measured result from
// Emil Huseynov's own studies (see SOURCES); nothing here is estimated by a model.

export const SOURCES = {
  row9: {
    short: 'npm provenance study',
    long: 'E. Huseynov, npm provenance attestations in the 2,000 most-downloaded npm packages (frame drawn 10 Aug 2026; mutable-input audit rerun 7 Nov 2026). Unpublished manuscript.'
  },
  lock: {
    short: 'actions.lock adoption snapshot',
    long: 'E. Huseynov, actions.lock adoption behind attested npm packages (snapshot 15 Nov 2026, 263 repositories). Unpublished measurement.'
  },
  row18: {
    short: 'Sigstore/Rekor study',
    long: 'E. Huseynov, what a Sigstore verification lets a third party inspect (uniform sample of 5,000 Rekor entries over 2,484,735,414 log positions). Unpublished manuscript.'
  },
  row15: {
    short: 'npm dist-tag study',
    long: 'E. Huseynov, npm dist-tags in the 5,000 most-downloaded packages and a uniform sample of 5,000 names (9,969 read). Unpublished manuscript.'
  }
};

export const EVIDENCE = {
  prov_adoption: {
    source: 'row9',
    text: '577 of the 2,000 most-downloaded npm packages carry provenance (28.9%).'
  },
  prov_commit: {
    source: 'row9',
    text: 'All 575 analysed attestations record the source commit.'
  },
  prov_branch: {
    source: 'row9',
    text: '441 of 575 attestations (76.7%) record a branch ref (refs/heads), not a tag.'
  },
  prov_mutable_ladder: {
    source: 'row9',
    text: 'Builds that referenced a GitHub Action by a mutable ref (n = 572): any action 358 (62.6%); excluding GitHub-owned actions 217 (37.9%); excluding GitHub-owned and same-owner actions 112 (19.6%).'
  },
  prov_alias: {
    source: 'row9',
    text: '96.3% of 2,581 mutable references are major-version aliases such as @v4.'
  },
  prov_drift: {
    source: 'row9',
    text: 'Over 29 days, 7 of 75 distinct mutable pointers genuinely moved (3 branches, 4 major tags); 0 of 11 exact tags moved.'
  },
  lock_repos: {
    source: 'lock',
    text: '2 of the 263 repositories (0.8%) behind the attested top packages have .github/workflows/actions.lock on the default branch, 18 days after GA.'
  },
  lock_releases: {
    source: 'lock',
    text: '1 of 194 attested releases published since the lockfile GA (28 Oct 2026) was built from a commit that contained the lockfile.'
  },
  sig_cert10: {
    source: 'row18',
    text: '4,725 of 4,731 parsed signing certificates are valid for exactly ten minutes.'
  },
  sig_public: {
    source: 'row18',
    text: 'Only 2.04% of Rekor entries name a source repository recorded public at signing; 7.57% when the single dominant issuer is excluded.'
  },
  sig_opaque: {
    source: 'row18',
    text: '73.04% of entries carry an opaque machine identity that names no owner.'
  },
  sig_digest: {
    source: 'row18',
    text: 'For 97.64% of entries the log stores only a digest of what was signed.'
  },
  tag_latest: {
    source: 'row15',
    text: '`latest` never pointed at a missing version: 0 of 9,969 packages (npm publish moves it automatically).'
  },
  tag_divergent: {
    source: 'row15',
    text: '25.24% of top packages publish a named tag on a different major from latest (1.83% in the random sample); 89.7% of those tags name a release older than latest.'
  },
  tag_stale: {
    source: 'row15',
    text: '`next`, `beta` and `alpha` are stale about nine times in ten; median staleness 914 days.'
  },
  tag_secondline: {
    source: 'row15',
    text: 'Only 4.44% of top packages keep a second release line genuinely in publication.'
  }
};

export function evidenceList(keys) {
  return keys.filter((k) => EVIDENCE[k]).map((k) => ({ key: k, ...EVIDENCE[k], sourceShort: SOURCES[EVIDENCE[k].source].short }));
}
