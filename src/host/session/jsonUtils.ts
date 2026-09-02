/**
 * jsonUtils — 轻量 JSON 类型守卫与访问助手，替代 gson 的 JsonObject/JsonArray
 * 判空与嵌套取值模式。raw JSON 来自 JSON.parse，用 `unknown` 承载，访问时逐步收窄。
 */

export interface JsonObject {
	[key: string]: unknown;
}

export type JsonArray = unknown[];

export function isObject(value: unknown): value is JsonObject {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isArray(value: unknown): value is JsonArray {
	return Array.isArray(value);
}

/** 取 obj[key] 当且仅当它是一个对象（非 null、非数组）。 */
export function getObj(obj: unknown, key: string): JsonObject | null {
	if (!isObject(obj)) {
		return null;
	}
	const value = (obj as JsonObject)[key];
	return isObject(value) ? value : null;
}

/** 取 obj[key] 当且仅当它是一个数组；数组里的元素原样保留。 */
export function getObjArray(obj: unknown, key: string): JsonArray | null {
	if (!isObject(obj)) {
		return null;
	}
	const value = (obj as JsonObject)[key];
	return isArray(value) ? value : null;
}

/** 取 obj[key] 的字符串值；非字符串返回 null。 */
export function getString(obj: unknown, key: string): string | null {
	if (!isObject(obj)) {
		return null;
	}
	const value = (obj as JsonObject)[key];
	return typeof value === 'string' ? value : null;
}

/** 取 obj[key] 的布尔值；非布尔返回 fallback。 */
export function getBool(obj: unknown, key: string, fallback = false): boolean {
	if (!isObject(obj)) {
		return fallback;
	}
	const value = (obj as JsonObject)[key];
	return typeof value === 'boolean' ? value : fallback;
}
