import test from 'node:test';
import assert from 'node:assert/strict';
import { COPY, resolveCopyKey, mapIdeLanguageToSupported } from './NotificationCopy.js';

test('COPY table contains all 10 supported languages', () => {
	const expectedLanguages = ['zh', 'zh-TW', 'en', 'es', 'fr', 'ja', 'ru', 'hi', 'ko', 'pt-BR'] as const;
	for (const lang of expectedLanguages) {
		assert.ok(COPY[lang], `COPY missing language: ${lang}`);
		assert.ok(COPY[lang].taskCompleted, `COPY[${lang}] missing taskCompleted`);
		assert.ok(COPY[lang].taskFailed, `COPY[${lang}] missing taskFailed`);
		assert.ok(COPY[lang].questionPending, `COPY[${lang}] missing questionPending`);
	}
});

test('Notification texts strictly use "OpenCode Buddy" branding without legacy Claude naming', () => {
	const languages = Object.keys(COPY) as Array<keyof typeof COPY>;
	for (const lang of languages) {
		const item = COPY[lang];
		assert.match(item.questionPending, /OpenCode Buddy/i, `Language ${lang} questionPending should mention OpenCode Buddy`);
		assert.doesNotMatch(item.questionPending, /Claude/i, `Language ${lang} questionPending must not contain Claude`);
		assert.doesNotMatch(item.taskCompleted, /Claude/i, `Language ${lang} taskCompleted must not contain Claude`);
		assert.doesNotMatch(item.taskFailed, /Claude/i, `Language ${lang} taskFailed must not contain Claude`);
	}
});

test('resolveCopyKey - user explicit language setting takes precedence', () => {
	assert.equal(resolveCopyKey('ja', 'zh-cn'), 'ja');
	assert.equal(resolveCopyKey('fr', 'en'), 'fr');
	assert.equal(resolveCopyKey('zh-TW', 'en'), 'zh-TW');
	assert.equal(resolveCopyKey('ko', 'ja'), 'ko');
	assert.equal(resolveCopyKey('pt-BR', 'en'), 'pt-BR');
});

test('resolveCopyKey - falls back to IDE language when userLanguage is empty/unset', () => {
	assert.equal(resolveCopyKey(null, 'zh-cn'), 'zh');
	assert.equal(resolveCopyKey('', 'zh-tw'), 'zh-TW');
	assert.equal(resolveCopyKey(undefined, 'ja'), 'ja');
	assert.equal(resolveCopyKey(null, 'ko'), 'ko');
	assert.equal(resolveCopyKey(null, 'es-ES'), 'es');
	assert.equal(resolveCopyKey(null, 'fr-FR'), 'fr');
	assert.equal(resolveCopyKey(null, 'pt-br'), 'pt-BR');
	assert.equal(resolveCopyKey(null, 'unknown-lang'), 'en');
});

test('mapIdeLanguageToSupported - correctly normalizes various locale strings', () => {
	assert.equal(mapIdeLanguageToSupported('zh-cn'), 'zh');
	assert.equal(mapIdeLanguageToSupported('zh-CN'), 'zh');
	assert.equal(mapIdeLanguageToSupported('zh-TW'), 'zh-TW');
	assert.equal(mapIdeLanguageToSupported('zh-HK'), 'zh-TW');
	assert.equal(mapIdeLanguageToSupported('ja-JP'), 'ja');
	assert.equal(mapIdeLanguageToSupported('ko-KR'), 'ko');
	assert.equal(mapIdeLanguageToSupported('es-ES'), 'es');
	assert.equal(mapIdeLanguageToSupported('fr-FR'), 'fr');
	assert.equal(mapIdeLanguageToSupported('pt-BR'), 'pt-BR');
	assert.equal(mapIdeLanguageToSupported('en-US'), 'en');
	assert.equal(mapIdeLanguageToSupported(''), 'en');
});
