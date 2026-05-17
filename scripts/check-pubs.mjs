/**
 * check-pubs.mjs
 *
 * Fetches publications from ORCID and reports any that are not yet associated
 * with an experience block.
 *
 * Keep PUB_BLOCK_MAP below in sync with src/components/HorizontalTimeline.tsx.
 *
 * Usage (local):
 *   node scripts/check-pubs.mjs
 *
 * In CI (GitHub Actions) it also creates/updates a GitHub Issue when
 * unmatched publications are found. Requires:
 *   GH_TOKEN          – GitHub token with issues:write permission
 *   GITHUB_REPOSITORY – owner/repo  (set automatically by Actions)
 */

// ─── ORCID ────────────────────────────────────────────────────────────────────
const ORCID_ID  = '0009-0005-4415-4962';
const ORCID_URL = `https://pub.orcid.org/v3.0/${ORCID_ID}/works`;

async function fetchPublications() {
  const res = await fetch(ORCID_URL, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`ORCID responded ${res.status}`);
  const data = await res.json();
  return (data.group ?? []).map(group => {
    const summary = group['work-summary']?.[0];
    if (!summary) return null;
    const yearStr  = summary['publication-date']?.year?.value;
    if (!yearStr) return null;
    const extIds   = summary['external-ids']?.['external-id'] ?? [];
    const doiEntry = extIds.find(e => e['external-id-type'] === 'doi');
    return {
      title: summary.title?.title?.value ?? 'Untitled',
      venue: summary['journal-title']?.value ?? null,
      doi:   doiEntry?.['external-id-url']?.value ?? null,
      year:  parseInt(yearStr),
    };
  }).filter(Boolean);
}

// ─── Pattern map — keep in sync with HorizontalTimeline.tsx ──────────────────
const PUB_BLOCK_MAP = [
  { pattern: /twixplorer/i,                                      blockId: 'ra-uoe'   },
  { pattern: /socioxplorer/i,                                    blockId: 'ra-uoe'   },
  { pattern: /\bfifa\b/i,                                        blockId: 'ra-uoe'   },
  { pattern: /\bsmr\b/i,                                         blockId: 'berkeley' },
  { pattern: /stance.?detect/i,                                  blockId: 'alygne'   },
  { pattern: /narrative.{0,30}spread|adversar/i,                 blockId: 'ra-uoe'   },
  { pattern: /insight.{0,20}inference/i,                         blockId: 'berkeley' },
  { pattern: /detect.{0,20}statements|statements.{0,20}detect/i, blockId: 'cdt-nlp' },
];

function matchBlock(title) {
  return PUB_BLOCK_MAP.find(m => m.pattern.test(title))?.blockId ?? null;
}

// ─── GitHub issue helper ──────────────────────────────────────────────────────
async function ghRequest(path, method = 'GET', body = null) {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return res.json();
}

async function ensureLabel(owner, repo) {
  await ghRequest(`/repos/${owner}/${repo}/labels`, 'POST', {
    name: 'orcid-unmatched',
    color: '0075ca',
    description: 'Unmatched ORCID publications awaiting experience assignment',
  }).catch(() => {}); // ignore if label already exists
}

async function upsertIssue(owner, repo, body) {
  const issues = await ghRequest(
    `/repos/${owner}/${repo}/issues?state=open&labels=orcid-unmatched&per_page=1`
  );
  if (Array.isArray(issues) && issues.length > 0) {
    await ghRequest(`/repos/${owner}/${repo}/issues/${issues[0].number}`, 'PATCH', { body });
    console.log(`Updated issue #${issues[0].number}`);
  } else {
    const issue = await ghRequest(`/repos/${owner}/${repo}/issues`, 'POST', {
      title: 'Unmatched ORCID publications — assign to experiences',
      labels: ['orcid-unmatched'],
      body,
    });
    console.log(`Created issue #${issue.number}`);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────
const pubs    = await fetchPublications();
const unmatched = pubs.filter(p => !matchBlock(p.title));

if (unmatched.length === 0) {
  console.log('All ORCID publications are assigned to an experience. Nothing to do.');
  process.exit(0);
}

// Always print to stdout (useful for local runs)
console.log(`\n${unmatched.length} unmatched publication(s):\n`);
for (const p of unmatched) {
  console.log(`  • "${p.title}" (${p.year})${p.venue ? ` — ${p.venue}` : ''}${p.doi ? `\n    DOI: ${p.doi}` : ''}`);
}

// Create/update GitHub Issue when running in CI
const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
const repo  = process.env.GITHUB_REPOSITORY; // "owner/repo"

if (token && repo) {
  const [owner, repoName] = repo.split('/');
  await ensureLabel(owner, repoName);

  const rows = unmatched.map(p => {
    const doiCol = p.doi ? `[DOI ↗](${p.doi})` : '—';
    return `| ${p.title} | ${p.year} | ${p.venue ?? '—'} | ${doiCol} |`;
  }).join('\n');

  const issueBody = `## Unmatched ORCID publications

The following publications were synced from ORCID but have not yet been associated with an experience on the timeline.

| Title | Year | Venue | DOI |
|-------|------|-------|-----|
${rows}

### How to assign

Add a regex entry to the \`PUB_BLOCK_MAP\` array in \`src/components/HorizontalTimeline.tsx\` **and** in \`scripts/check-pubs.mjs\`, then close this issue.

Example:
\`\`\`ts
{ pattern: /your keyword/i, blockId: 'ra-uoe' },
\`\`\`

Available block IDs: \`ba-york\`, \`msc-imperial\`, \`cdt-nlp\`, \`berkeley\`, \`ra-uoe\`, \`ati\`, \`sheffield\`, \`ta-uoe\`, \`teaching-fellow\`, \`project-manager\`, \`alygne\`, \`icwsm-web-chair\`.

_This issue is auto-updated on every weekly ORCID sync._`;

  await upsertIssue(owner, repoName, issueBody);
}
