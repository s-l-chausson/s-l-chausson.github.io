import { useState, useRef, useEffect, useCallback, Fragment } from 'react';
import { Star } from 'lucide-react';

// ─────────────────────────────────────────────────────────────────────────────
// Layout constants
// ─────────────────────────────────────────────────────────────────────────────
const PX_PER_MONTH  = 24;
const BLOCK_H       = 34;
const BLOCK_GAP     = 5;
const LANE_PAD_V    = 24;
const YEAR_H        = 30;
const EVT_DOT       = 24;
const EVT_ICON      = 14;
const EVT_SPACING   = 28;   // horizontal gap between clustered dots
const ORG_LOGO_BLOCK   = 16; // logos inside timeline blocks
const ORG_LOGO_TOOLTIP = 22; // logos in block tooltips
const LEGEND_DOT       = 22; // legend sample circles
const LEGEND_ICON      = 14;
const EVT_THRESH    = 24;   // x-distance (px) to cluster two events
const MIN_BLOCK_W   = 8;
const ORG_THRESHOLD = 72;   // min block width to show org badge

const TL_START = new Date(2014, 10); // Nov 2014
const TL_END   = new Date(2027, 6);  // Jul 2027
const NOW      = new Date(2026, 4);  // May 2026

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────
type LaneId    = 'education' | 'research' | 'teaching' | 'industry' | 'community';
type EventKind = 'award' | 'grant' | 'patent' | 'publication';

interface Block {
  id:             string;
  lane:           LaneId;
  title:          string;
  organisation?:  string;
  organisations?: string[];   // multiple orgs — takes precedence over organisation
  location?:      string;
  description?:   string;
  start:          Date;
  end:            Date | 'present';
  href?:          string;
  forceSubRow?:   number;
}

interface Evt {
  id:            string;
  kind:          EventKind;
  title:         string;
  organisation?: string;
  description?:  string;
  date:          Date;
  href?:         string;
  blockId:       string;
}

export interface PubEntry {
  title:  string;
  venue:  string | null;
  doi:    string | null;
  year:   number;
  month:  number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Visual config
// ─────────────────────────────────────────────────────────────────────────────
const LANE_CFG: Record<LaneId, { label: string; bg: string; border: string; text: string }> = {
  education: { label: 'Education',  bg: '#ede9fe', border: '#7c3aed', text: '#4c1d95' },
  research:  { label: 'Research',   bg: '#dbeafe', border: '#2563eb', text: '#1e3a8a' },
  teaching:  { label: 'Teaching',   bg: '#ccfbf1', border: '#0d9488', text: '#134e4a' },
  industry:  { label: 'Industry',   bg: '#fef3c7', border: '#d97706', text: '#78350f' },
  community: { label: 'Community',  bg: '#fce7f3', border: '#db2777', text: '#831843' },
};
const LANE_ORDER: LaneId[] = ['education', 'research', 'teaching', 'industry', 'community'];

// EVT_CFG still used for legend labels; dots themselves use the neutral palette below
const EVT_CFG: Record<EventKind, { label: string }> = {
  award:       { label: 'Award'       },
  grant:       { label: 'Grant'       },
  patent:      { label: 'Patent'      },
  publication: { label: 'Publication' },
};

// Neutral palette for org-logo fallbacks and legend dots
const DOT_BG     = '#f5f5f4'; // stone-100
const DOT_BORDER = '#a8a29e'; // stone-400
const DOT_ICON   = '#57534e'; // stone-600

// Event icon fill + outline (dot background comes from the parent block's lane)
const EVT_ICON_STYLE: Record<EventKind, { fill: string; stroke: string }> = {
  award:       { fill: '#eab308', stroke: '#92400e' }, // yellow fill, brown outline
  grant:       { fill: '#eab308', stroke: '#92400e' },
  publication: { fill: '#ffffff', stroke: '#44403c' }, // white fill, dark outline
  patent:      { fill: '#d4b896', stroke: '#78350f' }, // light brown fill, dark brown outline
};

// Kind sort order inside clusters — publications appear leftmost
const EVT_KIND_ORDER: Record<EventKind, number> = {
  publication: 0, award: 1, grant: 2, patent: 3,
};

// ─────────────────────────────────────────────────────────────────────────────
// Event icon
// ─────────────────────────────────────────────────────────────────────────────
function EvtIcon({ kind, size }: { kind: EventKind; size: number }) {
  const { fill, stroke } = EVT_ICON_STYLE[kind];
  const sw = size <= 12 ? 1.75 : 2;

  switch (kind) {
    case 'award':
      return <Star size={size} fill={fill} color={stroke} strokeWidth={sw} />;

    case 'grant':
      // Two filled coins with brown outline
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
          <circle cx="9" cy="14" r="6.5" fill={fill} stroke={stroke} strokeWidth={sw} />
          <circle cx="15" cy="10" r="6.5" fill={fill} stroke={stroke} strokeWidth={sw} />
        </svg>
      );

    case 'publication':
      // White-filled document with dark outline and text lines
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
          <path
            d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6z"
            fill={fill}
            stroke={stroke}
            strokeWidth={sw}
            strokeLinejoin="round"
          />
          <path
            d="M14 2v6h6"
            fill="none"
            stroke={stroke}
            strokeWidth={sw}
            strokeLinejoin="round"
          />
          <path
            d="M8 13h8M8 17h6"
            fill="none"
            stroke={stroke}
            strokeWidth={1.5}
            strokeLinecap="round"
          />
        </svg>
      );

    case 'patent':
      // Light-brown filled stamp with dark outline
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
          <rect
            x="4" y="4" width="16" height="16" rx="1"
            fill={fill}
            stroke={stroke}
            strokeWidth={sw}
          />
          <path
            d="M4 8V6M8 4H6M16 4h2M20 8V6M20 16v2M16 20h2M8 20H6M4 16v2"
            fill="none"
            stroke={stroke}
            strokeWidth={1.5}
            strokeLinecap="round"
          />
          <circle cx="12" cy="12" r="3" fill="none" stroke={stroke} strokeWidth={1.5} />
        </svg>
      );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Institution helpers
// ─────────────────────────────────────────────────────────────────────────────
interface OrgInfo { abbrev: string; domain: string; logoUrl?: string }

function getOrgInfo(org?: string): OrgInfo | null {
  if (!org) return null;
  if (/university of edinburgh/i.test(org))  return { abbrev: 'UoE',      domain: 'ed.ac.uk',       logoUrl: '/logos/uoe.png'        };
  if (/university of sheffield/i.test(org))  return { abbrev: 'UoSH',     domain: 'sheffield.ac.uk' };
  if (/university of york/i.test(org))       return { abbrev: 'UoY',      domain: 'york.ac.uk'      };
  if (/imperial college/i.test(org))         return { abbrev: 'ICL',      domain: 'imperial.ac.uk'  };
  if (/berkeley/i.test(org))                 return { abbrev: 'UCB',      domain: 'berkeley.edu'    };
  if (/alan turing/i.test(org))              return { abbrev: 'ATI',      domain: 'turing.ac.uk'    };
  if (/alygne/i.test(org))                   return { abbrev: 'Alygne',   domain: 'alygne.com',     logoUrl: '/logos/alygne.png'     };
  if (/prodemial/i.test(org))               return { abbrev: 'Prodemial', domain: 'prodemial.fr',   logoUrl: '/logos/prodemial.png'  };
  if (/icwsm|aaai/i.test(org))              return { abbrev: 'ICWSM',    domain: 'aaai.org'         };
  if (/dstl/i.test(org))                    return { abbrev: 'Dstl',     domain: 'dstl.gov.uk',    logoUrl: '/logos/dstl.png'       };
  return null;
}

function faviconUrl(domain: string, sz = 32) {
  return `https://www.google.com/s2/favicons?domain=${domain}&sz=${sz}`;
}

function parseOrg(org: string): { primary: string; sub?: string } {
  const m = org.match(/^([^—–]+?)\s*[—–]\s*(.+)$/);
  return m ? { primary: m[1].trim(), sub: m[2].trim() } : { primary: org };
}

function getBlockOrgs(block: Block): string[] {
  if (block.organisations?.length) return block.organisations;
  if (block.organisation) return [block.organisation];
  return [];
}

function getEvtLane(evt: Evt): LaneId {
  const block = BLOCKS.find(b => b.id === evt.blockId);
  return block?.lane ?? 'research';
}

// ─────────────────────────────────────────────────────────────────────────────
// OrgLogo — local logo or Google favicon, text abbreviation as fallback
// ─────────────────────────────────────────────────────────────────────────────
function OrgLogo({ info, size, color = DOT_ICON, bg = DOT_BG }: {
  info: OrgInfo; size: number; color?: string; bg?: string;
}) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <span className="inline-flex items-center justify-center rounded font-bold px-1"
            style={{ fontSize: Math.max(8, size * 0.55), backgroundColor: bg, color, lineHeight: 1 }}>
        {info.abbrev}
      </span>
    );
  }
  const src = info.logoUrl ?? faviconUrl(info.domain, size <= 18 ? 32 : 64);
  return (
    <img src={src} alt={info.abbrev} width={size} height={size}
         className="inline-block rounded-sm flex-shrink-0"
         style={{ objectFit: 'contain' }} onError={() => setFailed(true)} />
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Data — blocks
// ─────────────────────────────────────────────────────────────────────────────
const BLOCKS: Block[] = [
  // Education
  {
    id: 'ba-york', lane: 'education',
    title: 'BA Politics, Philosophy & Economics',
    organisation: 'University of York', location: 'York, UK',
    description: 'York Award 2016 & York Award Gold 2017.',
    start: new Date(2015, 8), end: new Date(2018, 5),
  },
  {
    id: 'msc-imperial', lane: 'education',
    title: 'MSc Computer Science',
    organisation: 'Imperial College London', location: 'London, UK',
    start: new Date(2019, 8), end: new Date(2020, 8),
  },
  {
    id: 'cdt-nlp', lane: 'education',
    title: 'CDT in Natural Language Processing',
    organisation: 'University of Edinburgh', location: 'Edinburgh, UK',
    description: 'EPSRC Centre for Doctoral Training in NLP. Research on computational methods for social media analysis, narrative detection, and text classification.',
    href: 'https://informatics.ed.ac.uk/ukri-cdt-in-natural-language-processing/people/students/cohort-2021',
    start: new Date(2021, 8), end: 'present',
  },
  // Research
  {
    id: 'berkeley', lane: 'research',
    title: 'Visiting Researcher',
    organisation: 'UC Berkeley — Department of Sociology', location: 'Berkeley, CA',
    description: 'Sponsored by Prof. Marion Fourcade & Prof. David Harding. Narrative spread on Twitter during the 2020 US elections and Capitol Hill riots.',
    forceSubRow: 1,   // put on row 1 so dashed pub connectors don't cross ra-uoe
    start: new Date(2022, 7), end: new Date(2022, 11),
  },
  {
    id: 'ra-uoe', lane: 'research',
    title: 'Research Assistant',
    organisations: ['University of Edinburgh — School of Informatics', 'Dstl'],
    location: 'Edinburgh, UK',
    description: 'Developed TwiXplorer with Dr Björn Ross & Dr Walid Magdy — a dashboard for social media narrative analysis in collaboration with Dstl.',
    start: new Date(2023, 5), end: new Date(2024, 11),
  },
  {
    id: 'ati', lane: 'research',
    title: 'PhD Enrichment Scheme',
    organisations: ['Alan Turing Institute', 'Dstl'],
    location: 'London, UK',
    description: 'Competitive scheme for PhD students at UK universities to spend time at the national institute for data science and AI.',
    href: 'https://www.turing.ac.uk/people/doctoral-students/sandrine-chausson',
    forceSubRow: 2,   // row 2: below berkeley (row 1) so its pub connectors don't overlap
    start: new Date(2024, 9), end: new Date(2025, 6),
  },
  {
    id: 'sheffield', lane: 'research',
    title: 'Research Associate',
    organisation: 'University of Sheffield — School of Information, Journalism and Communication',
    location: 'Sheffield, UK',
    description: 'Working with Dr Sara Torsner on profiling impunity for human rights violations against journalists. Methods: ML, Explainable AI, Generative AI, NoSQL.',
    href: 'https://sheffield.ac.uk/ijc/people/academic-staff/sandrine-chausson',
    forceSubRow: 2,   // same row as ati
    start: new Date(2025, 6), end: 'present',
  },
  // Teaching
  {
    id: 'ta-uoe', lane: 'teaching',
    title: 'Teaching Assistant',
    organisation: 'University of Edinburgh', location: 'Edinburgh, UK',
    href: '/teaching',
    start: new Date(2023, 1), end: new Date(2026, 2),
  },
  {
    id: 'teaching-fellow', lane: 'teaching',
    title: 'Teaching Fellow in Urban Data Science',
    organisation: 'University of Edinburgh — ESALA / Edinburgh Futures Institute',
    location: 'Edinburgh, UK',
    description: 'Creating and delivering content for two MSc courses: "Evaluating Sustainable Lands & Cities" and "Data, Mobility & Infrastructure". Student support, marking, and dissertation supervision.',
    href: '/teaching',
    start: new Date(2024, 11), end: new Date(2025, 10),
  },
  // Industry
  {
    id: 'project-manager', lane: 'industry',
    title: 'Project Manager',
    organisation: 'Prodemial, Omnium Finance Group',
    start: new Date(2018, 8), end: new Date(2019, 5),
  },
  {
    id: 'alygne', lane: 'industry',
    title: 'Research Scientist (AI / NLP)',
    organisation: 'Alygne Inc',
    description: 'R&D of an NLP pipeline for stance detection from news and social media. Led to a US patent (US-20220358293-A1).',
    start: new Date(2020, 9), end: new Date(2022, 11),
  },
  // Community
  {
    id: 'icwsm-web-chair', lane: 'community',
    title: 'Web Chair — ICWSM 2027',
    organisation: 'International AAAI Conference on Web and Social Media',
    href: 'https://www.icwsm.org/2027/',
    start: new Date(2026, 3), end: 'present',
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Static events
// ─────────────────────────────────────────────────────────────────────────────
const STATIC_EVENTS: Evt[] = [
  {
    id: 'patent', kind: 'patent', blockId: 'alygne',
    title: 'US Patent — Stance Detection Pipeline',
    organisation: 'US-20220358293-A1',
    description: 'Co-inventor. NLP pipeline for stance detection from news and social media.',
    date: new Date(2022, 10),
  },
  {
    id: 'grant-audience', kind: 'grant', blockId: 'ra-uoe',
    title: 'Grant — "Modelling Audience Interactions"',
    organisation: 'Dstl & Alan Turing Institute',
    date: new Date(2023, 5),
  },
  {
    id: 'grant-narratives', kind: 'grant', blockId: 'ra-uoe',
    title: 'Grant — "Finding Adversary Narratives: Topic and Momentum"',
    organisation: 'Dstl & Alan Turing Institute',
    date: new Date(2024, 3),
  },
  {
    id: 'cscw-award', kind: 'award', blockId: 'ra-uoe',
    title: 'Best Demo Award — TwiXplorer',
    organisation: 'ACM CSCW 2024',
    description: 'Awarded for TwiXplorer: An Interactive Tool for Narrative Detection and Analysis in Historic Twitter Data.',
    date: new Date(2024, 10),
  },
  {
    id: 'eusa-award', kind: 'award', blockId: 'teaching-fellow',
    title: 'EUSA Teaching Award — Nominated',
    organisation: "Edinburgh University Students' Association",
    date: new Date(2025, 2),
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Publication → block associations
// Keep in sync with scripts/check-pubs.mjs
// ─────────────────────────────────────────────────────────────────────────────
const PUB_BLOCK_MAP: { pattern: RegExp; blockId: string }[] = [
  { pattern: /twixplorer/i,                       blockId: 'ra-uoe'   },
  { pattern: /socioxplorer/i,                     blockId: 'ra-uoe'   },
  { pattern: /\bfifa\b/i,                         blockId: 'ra-uoe'   },
  { pattern: /\bsmr\b/i,                          blockId: 'berkeley' },
  { pattern: /stance.?detect/i,                   blockId: 'alygne'   },
  { pattern: /narrative.{0,30}spread|adversar/i,  blockId: 'ra-uoe'   },
  { pattern: /insight.{0,20}inference/i,          blockId: 'berkeley' },
  { pattern: /detect.{0,20}statements|statements.{0,20}detect/i, blockId: 'cdt-nlp' },
];

// ─────────────────────────────────────────────────────────────────────────────
// Layout helpers
// ─────────────────────────────────────────────────────────────────────────────
function mse(d: Date) { return d.getFullYear() * 12 + d.getMonth(); }
function toX(d: Date) { return (mse(d) - mse(TL_START)) * PX_PER_MONTH; }
function resolveEnd(e: Date | 'present') { return e === 'present' ? NOW : e; }

const TL_WIDTH = toX(TL_END);

function assignSubRows(blocks: Block[]): Map<string, number> {
  const sorted = [...blocks].sort((a, b) => mse(a.start) - mse(b.start));
  const rowEnds: number[] = [];
  const out = new Map<string, number>();

  // Greedy pass (skip forced)
  for (const b of sorted) {
    if (b.forceSubRow !== undefined) continue;
    const x0 = toX(b.start), x1 = toX(resolveEnd(b.end));
    let placed = false;
    for (let r = 0; r < rowEnds.length; r++) {
      if (x0 >= rowEnds[r]) { out.set(b.id, r); rowEnds[r] = x1; placed = true; break; }
    }
    if (!placed) { out.set(b.id, rowEnds.length); rowEnds.push(x1); }
  }

  // Forced placement
  for (const b of sorted) {
    if (b.forceSubRow === undefined) continue;
    const r  = b.forceSubRow;
    const x1 = toX(resolveEnd(b.end));
    out.set(b.id, r);
    while (rowEnds.length <= r) rowEnds.push(0);
    rowEnds[r] = Math.max(rowEnds[r], x1);
  }

  return out;
}

/**
 * Spread clustered events horizontally (same y-level, side by side).
 * Within each cluster events are sorted by kind: publication → award → grant → patent.
 */
function assignEvtOffsets(events: Evt[]): Map<string, { xOff: number; yOff: number }> {
  if (!events.length) return new Map();
  const sorted = [...events].sort((a, b) => toX(a.date) - toX(b.date));
  const offsets = new Map<string, { xOff: number; yOff: number }>();
  let i = 0;
  while (i < sorted.length) {
    const cx = toX(sorted[i].date);
    let j = i;
    while (j < sorted.length && toX(sorted[j].date) - cx < EVT_THRESH) j++;
    const cluster = sorted.slice(i, j).sort(
      (a, b) => EVT_KIND_ORDER[a.kind] - EVT_KIND_ORDER[b.kind]
    );
    cluster.forEach((evt, k) => {
      const xOff = (k - (cluster.length - 1) / 2) * EVT_SPACING;
      offsets.set(evt.id, { xOff, yOff: 0 });
    });
    i = j;
  }
  return offsets;
}

function getYearMarkers() {
  const out: { x: number; year: number; half: boolean }[] = [];
  for (let y = TL_START.getFullYear(); y <= TL_END.getFullYear(); y++) {
    out.push({ x: toX(new Date(y, 0)), year: y, half: false });
    out.push({ x: toX(new Date(y, 6)), year: y, half: true  });
  }
  return out;
}
const MARKS = getYearMarkers();

function fmtDate(d: Date | 'present') {
  if (d === 'present') return 'present';
  return d.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });
}

function navigate(href: string) {
  if (href.startsWith('http')) window.open(href, '_blank', 'noopener,noreferrer');
  else window.location.href = href;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tooltip — fully neutral (no per-lane/per-kind colouring)
// ─────────────────────────────────────────────────────────────────────────────
interface TooltipData {
  item: Block | Evt; kind: 'block' | 'event';
  anchorX: number; anchorY: number;
}
function isBlock(x: Block | Evt): x is Block { return 'lane' in x; }

function Tooltip({ data, wrapperRef }: {
  data: TooltipData;
  wrapperRef: React.RefObject<HTMLDivElement | null>;
}) {
  const { item, anchorX, anchorY } = data;
  const wr = wrapperRef.current?.getBoundingClientRect();
  if (!wr) return null;

  const relX   = anchorX - wr.left;
  const relY   = anchorY - wr.top;
  const TIP_W  = 288;
  const left   = Math.max(4, Math.min(relX - TIP_W / 2, wr.width - TIP_W - 4));
  const arrowL = Math.max(8, Math.min(relX - left - 5, TIP_W - 18));

  return (
    <div style={{ position: 'absolute', left, top: relY - 8,
                  transform: 'translateY(-100%)', width: TIP_W, zIndex: 50, pointerEvents: 'none' }}>
      <div className="rounded-lg shadow-xl bg-white text-xs border border-stone-200">

        {/* Title */}
        <div className="px-3 pt-2.5 pb-1.5 font-semibold leading-snug text-stone-800 border-b border-stone-100">
          {item.title}
        </div>

        {/* Body */}
        <div className="px-3 py-2.5 space-y-1.5 text-stone-600">
          {isBlock(item) ? (() => {
            const block = item as Block;
            const orgs  = getBlockOrgs(block);
            return (
              <>
                {orgs.length > 0 && (
                  <div className="flex flex-wrap gap-x-3 gap-y-1.5 mb-0.5">
                    {orgs.map(orgStr => {
                      const parsed = parseOrg(orgStr);
                      const info   = getOrgInfo(orgStr);
                      return (
                        <div key={orgStr} className="flex items-center gap-1.5 min-w-0">
                          {info && <OrgLogo info={info} size={ORG_LOGO_TOOLTIP} />}
                          <div className="min-w-0">
                            <p className="font-semibold text-stone-800 text-[11px] leading-tight truncate">
                              {parsed.primary}
                            </p>
                            {parsed.sub && (
                              <p className="text-stone-400 text-[10px] leading-tight truncate">
                                {parsed.sub}
                              </p>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
                {block.location && (
                  <p className="italic text-stone-400 text-[10px]">{block.location}</p>
                )}
                <p className="font-medium tabular-nums">
                  {fmtDate(block.start)} — {fmtDate(block.end)}
                </p>
                {block.description && (
                  <p className="leading-relaxed">{block.description}</p>
                )}
                {block.href && (
                  <p className="text-stone-400 text-[10px] mt-0.5">Click to open ↗</p>
                )}
              </>
            );
          })() : (() => {
            const evt  = item as Evt;
            const info = getOrgInfo(evt.organisation);
            return (
              <>
                <p className="font-medium tabular-nums">{fmtDate(evt.date)}</p>
                {evt.organisation && (
                  <div className="flex items-center gap-1.5">
                    {info && <OrgLogo info={info} size={18} />}
                    <p className="text-[11px]">{evt.organisation}</p>
                  </div>
                )}
                {evt.description && (
                  <p className="leading-relaxed mt-0.5">{evt.description}</p>
                )}
                {evt.href && (
                  <p className="text-stone-400 text-[10px] mt-0.5">Click to open DOI ↗</p>
                )}
              </>
            );
          })()}
        </div>
      </div>

      {/* Arrow */}
      <div style={{ position: 'absolute', bottom: -6, left: arrowL, width: 12, height: 8, overflow: 'hidden' }}>
        <div style={{ width: 10, height: 10, backgroundColor: 'white',
                      border: '1.5px solid #e7e5e4', transform: 'rotate(45deg)', margin: '-5px auto 0' }} />
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Reusable dot renderer
// ─────────────────────────────────────────────────────────────────────────────
function EvtDot({ evt, x, y, dragging, onClick, onEnter, onLeave }: {
  evt: Evt; x: number; y: number;
  dragging: React.MutableRefObject<boolean>;
  onClick:  (evt: Evt) => void;
  onEnter:  (e: React.MouseEvent, evt: Evt) => void;
  onLeave:  (e: React.MouseEvent) => void;
}) {
  const lane = LANE_CFG[getEvtLane(evt)];
  return (
    <div
      style={{
        position:        'absolute',
        left:            x - EVT_DOT / 2,
        top:             y - EVT_DOT / 2,
        width:           EVT_DOT, height: EVT_DOT,
        borderRadius:    '50%',
        backgroundColor: lane.bg,
        border:          `2px solid ${lane.border}`,
        display:         'flex', alignItems: 'center', justifyContent: 'center',
        cursor:          evt.href ? 'pointer' : 'default',
        zIndex:          4, transition: 'transform 0.1s, box-shadow 0.1s',
      }}
      onClick={() => { if (!dragging.current) onClick(evt); }}
      onMouseEnter={e => {
        (e.currentTarget as HTMLDivElement).style.transform  = 'scale(1.35)';
        (e.currentTarget as HTMLDivElement).style.boxShadow = `0 0 0 3px ${lane.bg}`;
        onEnter(e, evt);
      }}
      onMouseLeave={e => {
        (e.currentTarget as HTMLDivElement).style.transform  = '';
        (e.currentTarget as HTMLDivElement).style.boxShadow = '';
        onLeave(e);
      }}
    >
      <EvtIcon kind={evt.kind} size={EVT_ICON} />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main component
// ─────────────────────────────────────────────────────────────────────────────
interface Props { publications?: PubEntry[] }

export default function HorizontalTimeline({ publications = [] }: Props) {
  const wrapperRef  = useRef<HTMLDivElement>(null);
  const scrollRef   = useRef<HTMLDivElement>(null);
  const dragging    = useRef(false);
  const dragStartX  = useRef(0);
  const dragScrollL = useRef(0);
  const [tooltip, setTooltip] = useState<TooltipData | null>(null);

  // Open on "now"
  useEffect(() => {
    if (!scrollRef.current) return;
    const w = scrollRef.current.clientWidth;
    scrollRef.current.scrollLeft = Math.max(0, toX(NOW) - w + 160);
  }, []);

  // Drag-to-scroll
  const onMouseDown = useCallback((e: React.MouseEvent) => {
    dragging.current    = true;
    dragStartX.current  = e.pageX;
    dragScrollL.current = scrollRef.current?.scrollLeft ?? 0;
    if (scrollRef.current) scrollRef.current.style.cursor = 'grabbing';
  }, []);
  const onMouseMove = useCallback((e: React.MouseEvent) => {
    if (!dragging.current || !scrollRef.current) return;
    e.preventDefault();
    scrollRef.current.scrollLeft = dragScrollL.current - (e.pageX - dragStartX.current);
  }, []);
  const stopDrag = useCallback(() => {
    dragging.current = false;
    if (scrollRef.current) scrollRef.current.style.cursor = 'grab';
  }, []);

  // Separate matched from unmatched ORCID publications
  const pubEvents:       Evt[] = [];
  const unmatchedPubEvts: Evt[] = [];
  publications.forEach((p, i) => {
    const match = PUB_BLOCK_MAP.find(m => m.pattern.test(p.title));
    const evt: Evt = {
      id: `pub-${i}`, kind: 'publication',
      blockId: match?.blockId ?? '__unmatched__',
      title: p.title, organisation: p.venue ?? undefined,
      date: new Date(p.year, p.month), href: p.doi ?? undefined,
    };
    if (match) pubEvents.push(evt);
    else unmatchedPubEvts.push(evt);
  });

  const allEvents = [...STATIC_EVENTS, ...pubEvents];

  // Group matched events by blockId
  const blockEventsMap = new Map<string, Evt[]>();
  for (const evt of allEvents) {
    const arr = blockEventsMap.get(evt.blockId) ?? [];
    arr.push(evt);
    blockEventsMap.set(evt.blockId, arr);
  }

  // Lane layouts
  const laneLayouts = LANE_ORDER.map(id => {
    const laneBlocks = BLOCKS.filter(b => b.lane === id);
    const subRows    = assignSubRows(laneBlocks);
    const nRows      = laneBlocks.length === 0 ? 1 : Math.max(...subRows.values()) + 1;
    const height     = nRows * (BLOCK_H + BLOCK_GAP) - BLOCK_GAP + 2 * LANE_PAD_V;

    const blockLayouts = laneBlocks.map(block => {
      const row     = subRows.get(block.id) ?? 0;
      const x0      = toX(block.start);
      const x1      = toX(resolveEnd(block.end));
      const w       = Math.max(MIN_BLOCK_W, x1 - x0);
      const y       = LANE_PAD_V + row * (BLOCK_H + BLOCK_GAP);
      const centerY = y + BLOCK_H / 2;
      const events  = blockEventsMap.get(block.id) ?? [];
      return { block, x0, x1, w, y, centerY, events, evtOffsets: assignEvtOffsets(events) };
    });

    return { id, cfg: LANE_CFG[id], blockLayouts, height };
  });

  // Unmatched pubs strip
  const unmatchedOffsets   = assignEvtOffsets(unmatchedPubEvts);
  const UNMATCHED_STRIP_H  = 48;
  const unmatchedMidY      = UNMATCHED_STRIP_H / 2;

  const nowX = toX(NOW);

  function showBlock(e: React.MouseEvent, block: Block) {
    if (dragging.current) return;
    const r = e.currentTarget.getBoundingClientRect();
    setTooltip({ item: block, kind: 'block', anchorX: r.left + r.width / 2, anchorY: r.top });
  }
  function showEvt(e: React.MouseEvent, evt: Evt) {
    if (dragging.current) return;
    const r = e.currentTarget.getBoundingClientRect();
    setTooltip({ item: evt, kind: 'event', anchorX: r.left + r.width / 2, anchorY: r.top });
  }

  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div ref={wrapperRef} className="relative">

      {/* Legend */}
      <div className="flex flex-wrap gap-x-5 gap-y-1.5 mb-4 text-xs text-stone-500">
        {(Object.entries(EVT_CFG) as [EventKind, { label: string }][]).map(([k, c]) => (
          <span key={k} className="flex items-center gap-1.5">
            <span className="inline-flex items-center justify-center rounded-full"
                  style={{ width: LEGEND_DOT, height: LEGEND_DOT, backgroundColor: DOT_BG,
                           border: `1.5px solid ${DOT_BORDER}` }}>
              <EvtIcon kind={k} size={LEGEND_ICON} />
            </span>
            {c.label}
          </span>
        ))}
        <span className="flex items-center gap-1.5 ml-1">
          <span className="inline-block w-px h-3 bg-stone-600" />
          Today
        </span>
      </div>

      {/* Timeline */}
      <div ref={scrollRef}
           className="overflow-x-auto border border-stone-200 rounded-xl bg-white"
           style={{ cursor: 'grab', userSelect: 'none' }}
           onMouseDown={onMouseDown} onMouseMove={onMouseMove}
           onMouseUp={stopDrag} onMouseLeave={stopDrag}>
        <div style={{ width: TL_WIDTH, minWidth: '100%', position: 'relative' }}>

          {/* Year axis */}
          <div style={{ height: YEAR_H, position: 'relative' }}
               className="border-b border-stone-200 bg-stone-50/70 sticky top-0 z-10">
            {MARKS.map((m, i) => (
              <div key={i} style={{ position: 'absolute', left: m.x, top: 0, bottom: 0 }}>
                <div style={{ position: 'absolute', inset: 0,
                              borderLeft: m.half ? '1px dashed #e7e5e4' : '1px solid #d6d3d1' }} />
                {!m.half && (
                  <span className="absolute text-xs text-stone-400 tabular-nums" style={{ top: 7, left: 4 }}>
                    {m.year}
                  </span>
                )}
              </div>
            ))}
            <div style={{ position: 'absolute', left: nowX, top: 0, bottom: 0,
                          borderLeft: '2px solid #57534e', zIndex: 2 }} />
          </div>

          {/* Lane rows */}
          {laneLayouts.map((lane, li) => (
            <div key={lane.id}
                 style={{ height: lane.height, position: 'relative' }}
                 className={li < laneLayouts.length - 1 ? 'border-b border-stone-100' : ''}>

              {MARKS.filter(m => !m.half).map((m, i) => (
                <div key={i} style={{ position: 'absolute', left: m.x, top: 0, bottom: 0,
                                      borderLeft: '1px solid #f5f5f4' }} />
              ))}

              {/* Sticky lane pill */}
              <div style={{ position: 'sticky', left: 8, top: 0, zIndex: 5,
                            display: 'inline-flex', alignItems: 'center', height: '100%',
                            pointerEvents: 'none' }}>
                <span className="text-xs font-semibold px-2 py-0.5 rounded-full select-none"
                      style={{ backgroundColor: lane.cfg.bg, color: lane.cfg.text,
                               border: `1px solid ${lane.cfg.border}`, opacity: 0.9, letterSpacing: '0.04em' }}>
                  {lane.cfg.label}
                </span>
              </div>

              <div style={{ position: 'absolute', left: nowX, top: 0, bottom: 0,
                            borderLeft: '2px solid #d6d3d1', zIndex: 1 }} />

              {lane.blockLayouts.map(({ block, x0, x1, w, y, centerY, events, evtOffsets }) => {
                const ongoing  = block.end === 'present';
                const orgs     = getBlockOrgs(block);
                const orgInfos = orgs.map(getOrgInfo).filter(Boolean) as OrgInfo[];

                return (
                  <Fragment key={block.id}>
                    {/* Block */}
                    <div
                      style={{
                        position: 'absolute', left: x0, top: y, width: w, height: BLOCK_H,
                        backgroundColor: lane.cfg.bg,
                        borderLeft:  `3px solid ${lane.cfg.border}`,
                        borderRight: ongoing ? `3px dashed ${lane.cfg.border}` : undefined,
                        borderRadius: 6, overflow: 'hidden',
                        cursor: block.href ? 'pointer' : 'default',
                        zIndex: 2, boxSizing: 'border-box', transition: 'filter 0.1s',
                      }}
                      onClick={() => { if (!dragging.current && block.href) navigate(block.href); }}
                      onMouseEnter={e => {
                        (e.currentTarget as HTMLDivElement).style.filter = 'brightness(0.92)';
                        showBlock(e, block);
                      }}
                      onMouseLeave={e => {
                        (e.currentTarget as HTMLDivElement).style.filter = '';
                        setTooltip(null);
                      }}
                    >
                      {w > 48 && (
                        <div className="absolute inset-0 flex flex-col justify-center px-2 overflow-hidden">
                          <span className="text-xs font-medium leading-tight truncate"
                                style={{ color: lane.cfg.text }}>
                            {block.title}
                          </span>
                          {w > ORG_THRESHOLD && orgInfos.length > 0 && (
                            <span className="flex items-center gap-0.5 mt-0.5">
                              {orgInfos.map(info => (
                                <OrgLogo key={info.abbrev} info={info} size={ORG_LOGO_BLOCK}
                                         color={lane.cfg.text} bg={lane.cfg.bg} />
                              ))}
                              {orgInfos.length === 1 && (
                                <span className="text-[10px] leading-none truncate ml-0.5"
                                      style={{ color: lane.cfg.border, opacity: 0.85 }}>
                                  {orgInfos[0].abbrev}
                                </span>
                              )}
                            </span>
                          )}
                        </div>
                      )}
                    </div>

                    {/* Inline events */}
                    {events.map(evt => {
                      const evtX           = toX(evt.date);
                      const { xOff, yOff } = evtOffsets.get(evt.id) ?? { xOff: 0, yOff: 0 };
                      const actualX        = evtX + xOff;
                      const dotCY          = centerY + yOff;
                      const outside        = actualX < x0 || actualX > x1;
                      const evtLane        = LANE_CFG[getEvtLane(evt)];

                      const connLeft  = actualX < x0 ? actualX + EVT_DOT / 2 : x1;
                      const connWidth = actualX < x0
                        ? Math.max(0, x0 - actualX - EVT_DOT / 2)
                        : Math.max(0, actualX - EVT_DOT / 2 - x1);

                      return (
                        <Fragment key={evt.id}>
                          {outside && connWidth > 0 && (
                            <div style={{
                              position:  'absolute',
                              left:      connLeft, top: dotCY - 0.5,
                              width:     connWidth, height: 1,
                              borderTop: `1.5px dashed ${evtLane.border}`,
                              opacity: 0.5, zIndex: 1,
                            }} />
                          )}
                          <EvtDot evt={evt} x={actualX} y={dotCY}
                                  dragging={dragging}
                                  onClick={e => { if (e.href) navigate(e.href); }}
                                  onEnter={(e, ev) => showEvt(e, ev)}
                                  onLeave={() => setTooltip(null)} />
                        </Fragment>
                      );
                    })}
                  </Fragment>
                );
              })}
            </div>
          ))}

          {/* Unmatched publications strip */}
          {unmatchedPubEvts.length > 0 && (
            <div style={{ height: UNMATCHED_STRIP_H, position: 'relative' }}
                 className="border-t border-dashed border-stone-200">

              {MARKS.filter(m => !m.half).map((m, i) => (
                <div key={i} style={{ position: 'absolute', left: m.x, top: 0, bottom: 0,
                                      borderLeft: '1px solid #f5f5f4' }} />
              ))}

              <div style={{ position: 'absolute', left: nowX, top: 0, bottom: 0,
                            borderLeft: '2px solid #d6d3d1', zIndex: 1 }} />

              {/* Label */}
              <div style={{ position: 'sticky', left: 8, top: 0, zIndex: 5,
                            display: 'inline-flex', alignItems: 'center', height: '100%',
                            pointerEvents: 'none' }}>
                <span className="text-[11px] text-stone-400 italic select-none">
                  Other publications
                </span>
              </div>

              {unmatchedPubEvts.map(evt => {
                const evtX        = toX(evt.date);
                const { xOff }    = unmatchedOffsets.get(evt.id) ?? { xOff: 0 };
                const actualX     = evtX + xOff;
                return (
                  <EvtDot key={evt.id} evt={evt} x={actualX} y={unmatchedMidY}
                          dragging={dragging}
                          onClick={e => { if (e.href) navigate(e.href); }}
                          onEnter={(e, ev) => showEvt(e, ev)}
                          onLeave={() => setTooltip(null)} />
                );
              })}
            </div>
          )}

        </div>
      </div>

      <p className="mt-2 text-xs text-stone-400 text-center select-none">
        ← drag or scroll · hover for details · click to open link →
      </p>

      {tooltip && <Tooltip data={tooltip} wrapperRef={wrapperRef} />}
    </div>
  );
}
