import './mockVscode';
import * as assert from 'assert';
import { ListMessagesCollector } from '../host/util/ListMessagesCollector';

/**
 * `opencode.listMessages` 的分页契约：`nextCursor` 不是「还有更早」的证明。
 *
 * <p>opencode 2.x 在最后一页也会回 `cursor.next`（它只是本页最后一条的游标），
 * 所以 daemon 用 `rawCount`（过滤 idle/synthetic 之前的服务端条数）算出
 * `hasEarlier`。宿主必须照用这个布尔值，不能再 OR 一次游标 —— 否则「显示更早
 * 的对话」永远不清，且每次都要多点一次才发现真的到底了。</p>
 */
function pageDone(fields: Record<string, unknown>): string {
	return JSON.stringify({
		success: true,
		messagesDone: true,
		count: 0,
		...fields,
	});
}

suite('ListMessagesCollector keeps the daemon page contract', () => {
	test('a cursor on the last page does not mean there is an older page', () => {
		const collector = new ListMessagesCollector();

		collector.onLine(JSON.stringify({ success: true, messagesStart: true, count: 0 }));
		collector.onLine(pageDone({
			nextCursor: 'CUR_LAST',
			rawCount: 73,
			hasEarlier: false,
		}));

		assert.strictEqual(collector.getNextCursor(), 'CUR_LAST');
		assert.strictEqual(collector.getHasEarlier(), false);
	});

	test('a full server page reports an earlier page even when entries were filtered', () => {
		const collector = new ListMessagesCollector();

		collector.onLine(JSON.stringify({ success: true, messagesStart: true, count: 190 }));
		collector.onLine(pageDone({
			count: 190,
			nextCursor: 'CUR_OLDER',
			rawCount: 200,
			hasEarlier: true,
		}));

		assert.strictEqual(collector.getHasEarlier(), true);
	});

	test('an old daemon without hasEarlier falls back to the cursor', () => {
		const withCursor = new ListMessagesCollector();
		withCursor.onLine(pageDone({ nextCursor: 'CUR_NEXT' }));
		assert.strictEqual(withCursor.getHasEarlier(), true);

		const withoutCursor = new ListMessagesCollector();
		withoutCursor.onLine(pageDone({ nextCursor: null }));
		assert.strictEqual(withoutCursor.getHasEarlier(), false);
	});
});
