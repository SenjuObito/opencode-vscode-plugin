/**
 * McpMarketplaceHandler — MCP 市场浏览的宿主入口。
 *
 * 移植自 cc-gui（JetBrains 版）的 `handler/marketplace/McpMarketplaceHandler`：
 *   get_mcp_marketplace_sources → `updateMcpMarketplaceSources([...])`
 *   search_mcp_marketplace      → `updateMcpMarketplaceEntries({ query, sourceId, entries, error? })`
 *
 * 关键契约：无论成功还是失败，**都必须回一次 entries**。webview 的
 * `loading` 只在该回调里被清除，漏回就会让弹窗永远转圈。
 */
import { BaseMessageHandler } from '../router/MessageHandler';
import { HandlerContext } from '../router/HandlerContext';
import { McpMarketplaceService, type McpMarketplaceSearchResponse } from '../services/McpMarketplaceService';
import { logDiagnostic } from '../util/DiagnosticLogger';

const SUPPORTED_TYPES = ['get_mcp_marketplace_sources', 'search_mcp_marketplace'];

const DEFAULT_SOURCE_ID = 'built-in';

export class McpMarketplaceHandler extends BaseMessageHandler {
	private readonly marketplace: McpMarketplaceService;

	constructor(context: HandlerContext) {
		super(context);
		this.marketplace = new McpMarketplaceService();
	}

	getSupportedTypes(): string[] {
		return SUPPORTED_TYPES;
	}

	handle(type: string, content: string): boolean {
		switch (type) {
			case 'get_mcp_marketplace_sources':
				this.handleGetSources();
				return true;
			case 'search_mcp_marketplace':
				void this.handleSearch(content);
				return true;
			default:
				return false;
		}
	}

	private handleGetSources(): void {
		const sources = this.marketplace.getSources();
		logDiagnostic(`[MCP] marketplace sources count=${sources.length}`);
		this.callJavaScript('updateMcpMarketplaceSources', JSON.stringify(sources));
	}

	private async handleSearch(content: string): Promise<void> {
		const request = parseSearchRequest(content);
		const response: McpMarketplaceSearchResponse = {
			query: request.query,
			sourceId: request.sourceId,
			entries: [],
		};
		try {
			response.entries = await this.marketplace.search(request.query, request.sourceId, request.forceRefresh);
			logDiagnostic(
				`[MCP] marketplace search sourceId=${request.sourceId} query="${request.query}"`
				+ ` forceRefresh=${request.forceRefresh} entries=${response.entries.length}`,
			);
		} catch (err) {
			response.error = err instanceof Error ? err.message : String(err);
			logDiagnostic(`[MCP] marketplace search failed: ${response.error}`);
		}
		this.callJavaScript('updateMcpMarketplaceEntries', JSON.stringify(response));
	}
}

function parseSearchRequest(content: string): { query: string; sourceId: string; forceRefresh: boolean } {
	if (!content || content.trim() === '') {
		return { query: '', sourceId: DEFAULT_SOURCE_ID, forceRefresh: false };
	}
	let parsed: Record<string, unknown> = {};
	try {
		const value = JSON.parse(content) as unknown;
		if (value && typeof value === 'object' && !Array.isArray(value)) {
			parsed = value as Record<string, unknown>;
		}
	} catch {
		// 前端传入的仍是 "type:content" 字符串，解析失败时用默认值
	}
	const query = typeof parsed.query === 'string' ? parsed.query : '';
	const sourceId = typeof parsed.sourceId === 'string' && parsed.sourceId !== ''
		? parsed.sourceId
		: DEFAULT_SOURCE_ID;
	return { query, sourceId, forceRefresh: parsed.forceRefresh === true };
}
