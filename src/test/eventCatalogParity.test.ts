import * as assert from 'assert';
import { EventCatalog } from '../host/router/EventCatalog';

describe('EventCatalog parity and bidirectional mapping', () => {
	it('should resolve standard lifecycle events', () => {
		assert.strictEqual(EventCatalog.semanticType('onTabResync'), 'tab.resync');
		assert.strictEqual(EventCatalog.semanticType('window.onTabResync'), 'tab.resync');
		assert.strictEqual(EventCatalog.functionName('tab.resync'), 'onTabResync');

		assert.strictEqual(EventCatalog.semanticType('setSessionId'), 'session.bound');
		assert.strictEqual(EventCatalog.functionName('session.bound'), 'setSessionId');
	});

	it('should resolve turn and message events', () => {
		assert.strictEqual(EventCatalog.semanticType('onContentDelta'), 'content.delta');
		assert.strictEqual(EventCatalog.functionName('content.delta'), 'onContentDelta');

		assert.strictEqual(EventCatalog.semanticType('updateMessages'), 'message.snapshot');
		assert.strictEqual(EventCatalog.functionName('message.snapshot'), 'updateMessages');

		assert.strictEqual(EventCatalog.semanticType('onStreamStart'), 'turn.started');
		assert.strictEqual(EventCatalog.semanticType('onStreamEnd'), 'turn.ended');
		assert.strictEqual(EventCatalog.semanticType('onTurnEnd'), 'turn.settled');
	});

	it('should resolve prompt events', () => {
		assert.strictEqual(EventCatalog.semanticType('showPermissionDialog'), 'permission.requested');
		assert.strictEqual(EventCatalog.semanticType('showAskUserQuestionDialog'), 'question.requested');
		assert.strictEqual(EventCatalog.semanticType('showPlanApprovalDialog'), 'plan.requested');
	});

	it('should include VS Code multi-view synchronization events', () => {
		const multiViewTypes = [
			'tab.created',
			'tab.closed',
			'view.ready',
			'view.focus',
			'view.navigate',
			'prompt.host.changed',
			'tab.draft.changed',
			'tab.reordered',
		];

		for (const type of multiViewTypes) {
			assert.ok(EventCatalog.hasType(type), `Catalog should contain multi-view type ${type}`);
			const fn = EventCatalog.functionName(type);
			assert.ok(fn, `Type ${type} must have a corresponding fn name`);
			assert.strictEqual(EventCatalog.semanticType(fn), type);
		}
	});

	it('should gracefully fallback on unknown function names or types', () => {
		assert.strictEqual(EventCatalog.semanticType('customNonExistentFn'), 'customNonExistentFn');
		assert.strictEqual(EventCatalog.semanticType('window.someUnknownHandler'), 'someUnknownHandler');
		assert.strictEqual(EventCatalog.functionName('non.existent.type'), null);
		assert.strictEqual(EventCatalog.semanticType(''), '');
		assert.strictEqual(EventCatalog.functionName(null), null);
	});

	it('should contain at least 140 events', () => {
		assert.ok(EventCatalog.size() >= 140, `Catalog size (${EventCatalog.size()}) should be >= 140`);
	});
});
