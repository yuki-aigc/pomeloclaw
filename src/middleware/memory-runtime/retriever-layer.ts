import type { AgentMemoryConfig, AgentMemoryRetrievalMode } from '../../config.js';
import type { MemoryScope } from '../memory-scope.js';

type MemorySourceType = 'daily' | 'long-term' | 'transcript' | 'session' | 'heartbeat';

interface SearchRow {
    rel_path: string;
    chunk_index: number;
    start_line: number;
    end_line: number;
    content: string;
    source_type: MemorySourceType;
    score: number;
}

export interface MemoryRetrieverSearchHit {
    path: string;
    startLine: number;
    endLine: number;
    score: number;
    snippet: string;
    source: MemorySourceType;
    strategy: AgentMemoryRetrievalMode | 'keyword';
}

export interface MemoryRetrieverGetOptions {
    from?: number;
    lines?: number;
}

export interface MemoryRetrieverGetResult {
    path: string;
    scope: string;
    source: MemorySourceType;
    fromLine: number;
    toLine: number;
    lineCount: number;
    text: string;
    truncated: boolean;
}

export interface MemoryRetrieverLayerDeps {
    memoryConfig: AgentMemoryConfig;
    canUsePg: () => boolean;
    maybeSyncBeforeSearch: () => Promise<void>;
    searchFromFiles: (query: string, scope: MemoryScope) => Promise<MemoryRetrieverSearchHit[]>;
    searchPgKeywordUnified: (query: string, scopeKey: string, limit: number) => Promise<SearchRow[]>;
    searchPgFtsUnified: (query: string, scopeKey: string, limit: number) => Promise<SearchRow[]>;
    searchPgKeywordChunks: (query: string, scopeKey: string, limit: number) => Promise<SearchRow[]>;
    searchPgFtsChunks: (query: string, scopeKey: string, limit: number) => Promise<SearchRow[]>;
    searchPgVector: (query: string, scopeKey: string, limit: number) => Promise<SearchRow[]>;
    searchPgVectorChunks: (query: string, scopeKey: string, limit: number) => Promise<SearchRow[]>;
    searchPgSessionEventsFts: (query: string, scopeKey: string, limit: number) => Promise<SearchRow[]>;
    searchPgSessionEventsVector: (query: string, scopeKey: string, limit: number) => Promise<SearchRow[]>;
    searchPgSessionEventsTemporal: (query: string, scopeKey: string, limit: number) => Promise<SearchRow[]>;
    mergeRows: (rows: SearchRow[], limit: number) => SearchRow[];
    rowToHit: (row: SearchRow, strategy: MemoryRetrieverSearchHit['strategy']) => MemoryRetrieverSearchHit;
    mergeHybrid: (
        vectorRows: SearchRow[],
        ftsRows: SearchRow[],
        vectorWeight: number,
        ftsWeight: number,
    ) => MemoryRetrieverSearchHit[];
    readSessionEvent: (
        path: string,
        range: { from: number; lines: number },
        scope: MemoryScope,
    ) => Promise<MemoryRetrieverGetResult>;
    readMemoryFile: (
        path: string,
        range: { from: number; lines: number },
        scope: MemoryScope,
    ) => Promise<MemoryRetrieverGetResult>;
    maxMemoryGetLines: number;
    maxMemoryGetChars: number;
    defaultMemoryGetLines: number;
}

function normalizeRankScore(value: number): number {
    if (!Number.isFinite(value) || value <= 0) {
        return 0;
    }
    return value / (1 + value);
}

function isSharedMainMemoryPath(path: string): boolean {
    const normalized = path.replace(/\\/g, '/');
    if (normalized === 'MEMORY.md' || normalized === 'HEARTBEAT.md') {
        return true;
    }
    if (/^memory\/[^/]+\.md$/u.test(normalized)) {
        return true;
    }
    return normalized === 'memory/scopes/main/HEARTBEAT.md';
}

export class MemoryRetrieverLayer {
    constructor(private readonly deps: MemoryRetrieverLayerDeps) {}

    async search(query: string, scope: MemoryScope): Promise<MemoryRetrieverSearchHit[]> {
        const startedAt = Date.now();
        const mode = this.deps.memoryConfig.retrieval.mode;
        const queryForLog = query.replace(/\s+/g, ' ').trim().slice(0, 160);
        const finish = (
            hits: MemoryRetrieverSearchHit[],
            path: string,
            candidates: Record<string, number> = {},
            extra: Record<string, string | number | boolean> = {},
        ) => {
            this.logSearchTrace({
                scopeKey: scope.key,
                mode,
                query: queryForLog,
                path,
                candidates,
                hits,
                durationMs: Date.now() - startedAt,
                extra,
            });
            return hits;
        };
        const fileKeywordFallback = async () => await this.deps.searchFromFiles(query, scope);
        const sharedMainReadsEnabled = this.deps.memoryConfig.session_isolation.shared_main_scope_reads && scope.key !== 'main';
        const sharedMainSearchLimit = (limit: number) => Math.max(limit * 3, limit + 8);
        const getSharedMainKeywordRows = async (limit: number) =>
            sharedMainReadsEnabled
                ? (await this.deps.searchPgKeywordChunks(query, 'main', sharedMainSearchLimit(limit)))
                    .filter((row) => isSharedMainMemoryPath(row.rel_path))
                : [];
        const getSharedMainFtsRows = async (limit: number) =>
            sharedMainReadsEnabled
                ? (await this.deps.searchPgFtsChunks(query, 'main', sharedMainSearchLimit(limit)))
                    .filter((row) => isSharedMainMemoryPath(row.rel_path))
                : [];
        const getSharedMainVectorRows = async (limit: number) =>
            sharedMainReadsEnabled
                ? (await this.deps.searchPgVectorChunks(query, 'main', sharedMainSearchLimit(limit)))
                    .filter((row) => isSharedMainMemoryPath(row.rel_path))
                : [];

        if (this.deps.memoryConfig.backend !== 'pgsql' || !this.deps.canUsePg()) {
            const hits = await fileKeywordFallback();
            return finish(hits, 'filesystem_keyword_fallback', { fileHits: hits.length });
        }

        await this.deps.maybeSyncBeforeSearch();

        const maxResults = this.deps.memoryConfig.retrieval.max_results;
        const minScore = this.deps.memoryConfig.retrieval.min_score;
        const keywordFallback = async (fallbackFrom: string) => {
            const [currentRows, sharedMainRows] = await Promise.all([
                this.deps.searchPgKeywordUnified(query, scope.key, maxResults),
                getSharedMainKeywordRows(maxResults),
            ]);
            const rows = this.deps.mergeRows([...currentRows, ...sharedMainRows], maxResults);
            if (rows.length > 0) {
                const hits = rows
                    .map((row) => this.deps.rowToHit(row, 'keyword'))
                    .filter((item) => item.score >= minScore)
                    .slice(0, maxResults);
                return finish(hits, `${fallbackFrom}_keyword`, {
                    keywordRows: currentRows.length,
                    sharedMainKeywordRows: sharedMainRows.length,
                    keywordHits: hits.length,
                });
            }
            const fileHits = await fileKeywordFallback();
            return finish(fileHits, `${fallbackFrom}_file_keyword`, {
                keywordRows: currentRows.length,
                sharedMainKeywordRows: sharedMainRows.length,
                fileHits: fileHits.length,
            });
        };

        if (mode === 'keyword') {
            return keywordFallback('mode_keyword');
        }

        if (mode === 'fts') {
            const [currentRows, sharedMainRows] = await Promise.all([
                this.deps.searchPgFtsUnified(query, scope.key, maxResults),
                getSharedMainFtsRows(maxResults),
            ]);
            const rows = this.deps.mergeRows([...currentRows, ...sharedMainRows], maxResults);
            if (rows.length === 0) {
                return keywordFallback('mode_fts_empty');
            }
            const hits = rows
                .map((row) => this.deps.rowToHit(row, 'fts'))
                .filter((item) => normalizeRankScore(item.score) >= minScore)
                .map((item) => ({ ...item, score: normalizeRankScore(item.score) }))
                .sort((a, b) => b.score - a.score)
                .slice(0, maxResults);
            return finish(hits, 'mode_fts', {
                ftsRows: currentRows.length,
                sharedMainFtsRows: sharedMainRows.length,
                ftsHits: hits.length,
            });
        }

        if (mode === 'vector') {
            const candidates = Math.max(
                maxResults,
                Math.floor(maxResults * this.deps.memoryConfig.retrieval.hybrid_candidate_multiplier),
            );
            const [vectorRows, sharedMainVectorRows, sessionRows, sessionVectorRows, temporalRows] = await Promise.all([
                this.deps.searchPgVector(query, scope.key, candidates),
                getSharedMainVectorRows(candidates),
                this.deps.searchPgSessionEventsFts(query, scope.key, candidates),
                this.deps.searchPgSessionEventsVector(query, scope.key, candidates),
                this.deps.searchPgSessionEventsTemporal(query, scope.key, candidates),
            ]);
            const mergedVectorRows = this.deps.mergeRows(
                [...vectorRows, ...sharedMainVectorRows, ...sessionVectorRows],
                candidates,
            );
            const mergedSessionRows = this.deps.mergeRows([...sessionRows, ...temporalRows], candidates);

            if (mergedVectorRows.length === 0) {
                const [ftsRowsCurrent, ftsRowsShared] = await Promise.all([
                    this.deps.searchPgFtsUnified(query, scope.key, maxResults),
                    getSharedMainFtsRows(maxResults),
                ]);
                const ftsRows = this.deps.mergeRows([...ftsRowsCurrent, ...ftsRowsShared], maxResults);
                if (ftsRows.length === 0) {
                    return keywordFallback('mode_vector_empty');
                }
                const hits = ftsRows
                    .map((row) => this.deps.rowToHit(row, 'fts'))
                    .map((item) => ({ ...item, score: normalizeRankScore(item.score) }))
                    .filter((item) => item.score >= minScore)
                    .sort((a, b) => b.score - a.score)
                    .slice(0, maxResults);
                return finish(hits, 'mode_vector_fallback_fts', {
                    vectorRows: vectorRows.length,
                    sharedMainVectorRows: sharedMainVectorRows.length,
                    sessionVectorRows: sessionVectorRows.length,
                    mergedVectorRows: mergedVectorRows.length,
                    sessionFtsRows: sessionRows.length,
                    temporalRows: temporalRows.length,
                    ftsRows: ftsRowsCurrent.length,
                    sharedMainFtsRows: ftsRowsShared.length,
                    hits: hits.length,
                });
            }

            if (mergedSessionRows.length > 0) {
                const merged = this.deps.mergeHybrid(
                    mergedVectorRows,
                    mergedSessionRows,
                    this.deps.memoryConfig.retrieval.hybrid_vector_weight,
                    this.deps.memoryConfig.retrieval.hybrid_fts_weight,
                ).map((item) => ({ ...item, strategy: 'vector' as const }));
                const hits = merged
                    .filter((item) => item.score >= minScore)
                    .slice(0, maxResults);
                return finish(hits, 'mode_vector_with_session_merge', {
                    vectorRows: vectorRows.length,
                    sharedMainVectorRows: sharedMainVectorRows.length,
                    sessionVectorRows: sessionVectorRows.length,
                    mergedVectorRows: mergedVectorRows.length,
                    sessionFtsRows: sessionRows.length,
                    temporalRows: temporalRows.length,
                    mergedSessionRows: mergedSessionRows.length,
                    hits: hits.length,
                });
            }

            const hits = mergedVectorRows
                .map((row) => this.deps.rowToHit(row, 'vector'))
                .filter((item) => item.score >= minScore)
                .slice(0, maxResults);
            return finish(hits, 'mode_vector_only', {
                vectorRows: vectorRows.length,
                sharedMainVectorRows: sharedMainVectorRows.length,
                sessionVectorRows: sessionVectorRows.length,
                mergedVectorRows: mergedVectorRows.length,
                sessionFtsRows: sessionRows.length,
                temporalRows: temporalRows.length,
                hits: hits.length,
            });
        }

        const candidates = Math.max(
                maxResults,
                Math.floor(maxResults * this.deps.memoryConfig.retrieval.hybrid_candidate_multiplier),
            );
        const [ftsRowsCurrent, ftsRowsShared, vectorRows, sharedMainVectorRows, sessionVectorRows] = await Promise.all([
            this.deps.searchPgFtsUnified(query, scope.key, candidates),
            getSharedMainFtsRows(candidates),
            this.deps.searchPgVector(query, scope.key, candidates),
            getSharedMainVectorRows(candidates),
            this.deps.searchPgSessionEventsVector(query, scope.key, candidates),
        ]);
        const ftsRows = this.deps.mergeRows([...ftsRowsCurrent, ...ftsRowsShared], candidates);
        const mergedVectorRows = this.deps.mergeRows(
            [...vectorRows, ...sharedMainVectorRows, ...sessionVectorRows],
            candidates,
        );

        if (mergedVectorRows.length === 0 && ftsRows.length === 0) {
            return keywordFallback('mode_hybrid_empty');
        }

        const merged = this.deps.mergeHybrid(
            mergedVectorRows,
            ftsRows,
            this.deps.memoryConfig.retrieval.hybrid_vector_weight,
            this.deps.memoryConfig.retrieval.hybrid_fts_weight,
        );

        const hits = merged
            .filter((item) => item.score >= minScore)
            .slice(0, maxResults);
        return finish(hits, 'mode_hybrid', {
            ftsRows: ftsRowsCurrent.length,
            sharedMainFtsRows: ftsRowsShared.length,
            vectorRows: vectorRows.length,
            sharedMainVectorRows: sharedMainVectorRows.length,
            sessionVectorRows: sessionVectorRows.length,
            mergedVectorRows: mergedVectorRows.length,
            hits: hits.length,
        });
    }

    async get(path: string, options: MemoryRetrieverGetOptions | undefined, scope: MemoryScope): Promise<MemoryRetrieverGetResult> {
        const resolved = this.normalizeGetRequest(path, options);
        if (!resolved.path) {
            throw new Error('memory_get path is required');
        }

        if (resolved.path.startsWith('session_events/')) {
            return this.deps.readSessionEvent(resolved.path, resolved.range, scope);
        }

        return this.deps.readMemoryFile(resolved.path, resolved.range, scope);
    }

    private normalizeGetRequest(
        path: string,
        options: MemoryRetrieverGetOptions | undefined,
    ): { path: string; range: { from: number; lines: number } } {
        const rawPath = (path || '').trim();
        let normalizedPath = rawPath
            .replace(/^`+|`+$/g, '')
            .trim();

        if (/^\[.+\]$/u.test(normalizedPath)) {
            normalizedPath = normalizedPath.slice(1, -1).trim();
        }

        let inferredFrom: number | undefined;
        const lineSuffixMatch = normalizedPath.match(/^(.*):(\d+)(?::\d+)?$/u);
        if (lineSuffixMatch) {
            const basePath = lineSuffixMatch[1]?.trim() ?? '';
            const fromLine = Number(lineSuffixMatch[2]);
            if (basePath && Number.isSafeInteger(fromLine) && fromLine > 0) {
                normalizedPath = basePath;
                inferredFrom = fromLine;
            }
        }

        const range = this.normalizeGetRange({
            ...options,
            from: options?.from ?? inferredFrom,
        });
        return {
            path: normalizedPath,
            range,
        };
    }

    private normalizeGetRange(options?: MemoryRetrieverGetOptions): { from: number; lines: number } {
        const from = Math.max(1, Math.floor(options?.from ?? 1));
        const requestedLines = Math.floor(options?.lines ?? this.deps.defaultMemoryGetLines);
        const lines = Math.max(1, Math.min(this.deps.maxMemoryGetLines, requestedLines));
        return { from, lines };
    }

    private logSearchTrace(params: {
        scopeKey: string;
        mode: AgentMemoryRetrievalMode;
        query: string;
        path: string;
        candidates: Record<string, number>;
        hits: MemoryRetrieverSearchHit[];
        durationMs: number;
        extra?: Record<string, string | number | boolean>;
    }): void {
        const sourceCounts: Record<string, number> = {};
        const strategyCounts: Record<string, number> = {};
        for (const hit of params.hits) {
            sourceCounts[hit.source] = (sourceCounts[hit.source] ?? 0) + 1;
            strategyCounts[hit.strategy] = (strategyCounts[hit.strategy] ?? 0) + 1;
        }

        const top = params.hits
            .slice(0, 3)
            .map((hit) => `${this.trimLogValue(hit.path, 56)}@${hit.score.toFixed(3)}`)
            .join('|') || 'none';

        const candidateSummary = this.summarizeCountMap(params.candidates);
        const sourceSummary = this.summarizeCountMap(sourceCounts);
        const strategySummary = this.summarizeCountMap(strategyCounts);
        const extraSummary = params.extra ? this.summarizeExtraMap(params.extra) : 'none';

        console.info(
            `[Memory][Search] scope=${params.scopeKey} mode=${params.mode} path=${params.path} query="${this.trimLogValue(params.query, 80)}" durationMs=${params.durationMs} candidates={${candidateSummary}} hits=${params.hits.length} bySource={${sourceSummary}} byStrategy={${strategySummary}} extra={${extraSummary}} top={${top}}`
        );
    }

    private summarizeCountMap(values: Record<string, number>): string {
        const entries = Object.entries(values)
            .filter(([, value]) => Number.isFinite(value) && value >= 0)
            .sort((a, b) => b[1] - a[1]);
        if (entries.length === 0) {
            return 'none';
        }
        return entries.map(([key, value]) => `${key}:${value}`).join(',');
    }

    private summarizeExtraMap(values: Record<string, string | number | boolean>): string {
        const entries = Object.entries(values);
        if (entries.length === 0) {
            return 'none';
        }
        return entries.map(([key, value]) => `${key}:${String(value)}`).join(',');
    }

    private trimLogValue(value: string, maxChars: number): string {
        const normalized = value.replace(/\s+/g, ' ').trim();
        if (normalized.length <= maxChars) {
            return normalized;
        }
        return `${normalized.slice(0, Math.max(0, maxChars - 1))}…`;
    }
}
