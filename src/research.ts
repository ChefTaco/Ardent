import { z } from 'zod';
import { TeamResult } from './team-contract.js';

export const ResearchBriefSchema = z.object({
  question: z.string().min(1),
  scope: z.string().min(1),
  as_of: z.string().datetime({ offset: true }),
  findings: z.array(z.string().min(1)).max(20),
  claims: z.array(z.object({ text: z.string().min(1), source_ids: z.array(z.string().min(1)).min(1), qualification: z.string() })).max(50),
  contrary_evidence: z.array(z.string()).max(20),
  coverage_gaps: z.array(z.string()).max(20),
  artifact_ids: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(20),
  answer_markdown: z.string().min(1),
  source_assessments: z.array(z.object({ source_id: z.string(), reporting_role: z.enum(['original', 'secondary', 'unknown']), basis: z.string().min(1).max(500) })).max(100).optional(),
  source_register: z.array(z.object({ source_id: z.string(), url: z.string().url(), evidence_kind: z.enum(['search_snippet', 'extracted_article']), reporting_role: z.enum(['original', 'secondary', 'unknown']), role_basis: z.string().nullable(), title: z.string(), published_at: z.string().nullable(), retrieved_at: z.string().nullable(), content_sha256: z.string().nullable() })).max(100).optional(),
  candidate_slate: z.array(z.object({ source_id: z.string().min(1), headline: z.string().trim().min(1).max(180),
    summary: z.string().trim().min(1).max(600), why_positive: z.string().trim().min(1).max(240),
    topic: z.string().trim().min(1).max(80), location: z.string().trim().min(1).max(100),
    scores: z.object({ recency: z.number().int().min(1).max(5), reliability: z.number().int().min(1).max(5),
      impact: z.number().int().min(1).max(5), specificity: z.number().int().min(1).max(5),
      constructive_value: z.number().int().min(1).max(5), user_relevance: z.number().int().min(1).max(5) }).strict() }).strict()).min(1).max(20).optional(),
  syndication_groups: z.array(z.array(z.string()).min(2)).max(50).optional(),
  team_result: TeamResult.optional()
}).strict();
export type ResearchBrief = z.infer<typeof ResearchBriefSchema>;

/** Correct observed read-only formatting slips, then run the full research and
 * team schemas. An aliased URL must match that source ID's retained evidence. */
export function repairObservedResearchFormat(text: string, sourceIds: ReadonlySet<string>,
  artifactIds: ReadonlySet<string>, sourceUrls: ReadonlySet<string>,
  sourceUrlById?: ReadonlyMap<string, string>): string | null {
  let raw: unknown;
  try { raw = JSON.parse(text) as unknown; } catch { return null; }
  const object = z.record(z.string(), z.unknown()).safeParse(raw);
  if (!object.success || Buffer.byteLength(text, 'utf8') > 64_000) return null;
  const candidate = { ...object.data };
  let changed = false;
  if (Array.isArray(candidate.source_register) && candidate.source_register.length <= 100) {
    const normalized: unknown[] = [];
    for (const entry of candidate.source_register) {
      const source = z.record(z.string(), z.unknown()).safeParse(entry);
      if (!source.success) return null;
      if (!('exact_url' in source.data)) { normalized.push(entry); continue; }
      const { exact_url, ...fields } = source.data;
      if (typeof fields.source_id !== 'string' || typeof exact_url !== 'string' ||
          sourceUrlById?.get(fields.source_id) !== exact_url ||
          (fields.url !== undefined && fields.url !== exact_url)) return null;
      normalized.push({ ...fields, url: exact_url });
      changed = true;
    }
    candidate.source_register = normalized;
  }
  if (Array.isArray(candidate.findings) && candidate.findings.length <= 20) {
    const finding = z.object({ source_url: z.string().url(), retrieved_at: z.string().datetime({ offset: true }),
      publisher_date: z.string().max(500), event_date: z.string().max(500) }).strict();
    const normalized: unknown[] = [];
    for (const entry of candidate.findings) {
      if (typeof entry === 'string') { normalized.push(entry); continue; }
      const parsed = finding.safeParse(entry);
      if (!parsed.success || !sourceUrls.has(parsed.data.source_url)) return null;
      normalized.push(JSON.stringify(parsed.data));
      changed = true;
    }
    candidate.findings = normalized;
  }
  const team = z.record(z.string(), z.unknown()).safeParse(candidate.team_result);
  if (team.success && Array.isArray(team.data.checks) && team.data.checks.length === 1) {
    const check = z.record(z.string(), z.unknown()).safeParse(team.data.checks[0]);
    if (check.success && typeof check.data.evidence === 'string') {
      const reference = check.data.evidence;
      if (!reference.startsWith('source:') || !sourceUrls.has(reference.slice(7))) return null;
      candidate.team_result = { ...team.data, checks: [{ ...check.data, evidence: [reference] }] };
      changed = true;
    }
  }
  if (!changed) return null;
  const corrected = JSON.stringify(candidate);
  try { parseResearchBrief(corrected, sourceIds, artifactIds); } catch { return null; }
  return corrected;
}

/** Wrap only single-string research arrays after all other fields and citations validate. */
export function repairResearchArrayStrings(text: string, sourceIds: ReadonlySet<string>, artifactIds: ReadonlySet<string>):
  { text: string; fields: Array<'findings' | 'coverage_gaps'> } | null {
  let raw: unknown;
  try { raw = JSON.parse(text) as unknown; } catch { return null; }
  const object = z.record(z.string(), z.unknown()).safeParse(raw);
  if (!object.success) return null;
  const { coverage_gaps: gaps, ...other } = object.data;
  if (typeof gaps !== 'string' || !gaps.trim() || Buffer.byteLength(gaps, 'utf8') > 2000) return null;
  const findings = other.findings;
  if (typeof findings === 'string' && (!findings.trim() || Buffer.byteLength(findings, 'utf8') > 2000)) return null;
  const fields: Array<'findings' | 'coverage_gaps'> = typeof findings === 'string'
    ? ['findings', 'coverage_gaps'] : ['coverage_gaps'];
  const normalized = typeof findings === 'string' ? { ...other, findings: [findings] } : other;
  if (!ResearchBriefSchema.omit({ coverage_gaps: true }).safeParse(normalized).success) return null;
  const corrected = JSON.stringify({ ...normalized, coverage_gaps: [gaps] });
  try { parseResearchBrief(corrected, sourceIds, artifactIds); }
  catch { return null; }
  return { text: corrected, fields };
}

export function parseResearchBrief(text: string, sourceIds: ReadonlySet<string>, artifactIds: ReadonlySet<string>): ResearchBrief {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error('Research result is not JSON'); }
  if (typeof value === 'object' && value !== null && !Array.isArray(value) && 'findings' in value && typeof value.findings === 'string') {
    // A single finding is unambiguous; keep citation and claim validation strict.
    value = { ...value, findings: value.findings.trim() ? [value.findings] : [] };
  }
  const brief = ResearchBriefSchema.parse(value);
  for (const claim of brief.claims) for (const id of claim.source_ids) if (!sourceIds.has(id)) throw new Error(`Research claim cites unknown source ${id}`);
  for (const source of brief.source_assessments ?? []) if (!sourceIds.has(source.source_id)) throw new Error(`Research assessment cites unknown source ${source.source_id}`);
  for (const source of brief.source_register ?? []) if (!sourceIds.has(source.source_id)) throw new Error(`Research register cites unknown source ${source.source_id}`);
  for (const candidate of brief.candidate_slate ?? []) if (!sourceIds.has(candidate.source_id)) throw new Error(`Research candidate cites unknown source ${candidate.source_id}`);
  for (const id of brief.artifact_ids) if (!artifactIds.has(id)) throw new Error(`Research result cites unknown artifact ${id}`);
  if (!sourceIds.size && brief.claims.length) throw new Error('Research result contains claims without retrieved sources');
  if (!sourceIds.size && (brief.findings.length || !brief.coverage_gaps.length)) throw new Error('Empty retrieval requires empty findings and an explicit coverage gap');
  return brief;
}
