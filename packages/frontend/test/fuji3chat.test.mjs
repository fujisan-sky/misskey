/*
 * SPDX-FileCopyrightText: mikop and fujisansky-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// Executes the real Vue page with local account/network stubs. No live login occurs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Window } from 'happy-dom';
import { parse, compileScript } from 'vue/compiler-sfc';
import ts from 'typescript';

const window = new Window({ url: 'https://gp.miku2go.com/fuji3chat' });
for (const name of ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'SVGElement']) {
	Object.defineProperty(globalThis, name, { configurable: true, value: name === 'window' ? window : window[name] });
}
const vue = await import('vue');
const asModule = source => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
const { descriptor } = parse(await readFile(new URL('../src/pages/fuji3chat.vue', import.meta.url), 'utf8'));
let source = compileScript(descriptor, { id: 'fuji3chat-test', inlineTemplate: true }).content;
const imports = {
	'vue': import.meta.resolve('vue'),
	'@/components/MkButton.vue': asModule('export default {template:"<button><slot/></button>"}'),
	'@/i.js': asModule('export const $i={token:"native-user-token"}'),
	'@/i18n.js': asModule('export const i18n={ts:{retry:"retry",_fuji3chat:{title:"Chat",connecting:"connecting",failed:"failed"}}}'),
	'@/page.js': asModule('export const definePage=()=>{}'),
};
for (const [name, url] of Object.entries(imports)) source = source.replaceAll(`'${name}'`, `'${url}'`).replaceAll(`"${name}"`, `"${url}"`);
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
const Page = (await import(asModule(compiled))).default;
const state = 's'.repeat(43), challenge = 'h'.repeat(43), code = 'c'.repeat(43);

async function mount(t, url, status = 200) {
	window.happyDOM.setURL(url);
	const navigations = [], requests = [];
	window.location.replace = url => navigations.push(url);
	window.fetch = async (url, options) => { requests.push({ url, ...options }); return { ok: status === 200, json: async () => ({ code }) }; };
	const element = window.document.createElement('div'); window.document.body.appendChild(element);
	const app = vue.createApp(Page); app.component('MkSpacer', { template: '<div><slot/></div>' }); app.mount(element);
	t.after(() => { app.unmount(); element.remove(); });
	await new Promise(resolve => setTimeout(resolve, 20));
	return { navigations, requests, element };
}

test('menu entry starts at the paired Chat server without exposing a token', async t => {
	const result = await mount(t, 'https://gp.miku2go.com/fuji3chat');
	assert.deepEqual(result.navigations, ['https://chat.misskey.pink/api/auth/fuji3chat/start']);
	assert.equal(result.requests.length, 0);
});

test('bound return issues on the same origin and navigates only to paired callback', async t => {
	const result = await mount(t, `https://gp.miku2go.com/fuji3chat?state=${state}&code_challenge=${challenge}`);
	assert.equal(result.requests[0].url, '/api/fuji3chat/issue');
	assert.deepEqual(JSON.parse(result.requests[0].body), { i: 'native-user-token', state, codeChallenge: challenge });
	const callback = new URL(result.navigations[0]);
	assert.equal(callback.origin, 'https://chat.misskey.pink');
	assert.equal(callback.searchParams.get('code'), code);
	assert.equal(callback.searchParams.get('state'), state);
	assert.equal(callback.href.includes('native-user-token'), false);
	assert.equal(window.location.search, '');
});

test('invalid parameters and failed issue remain on a retry screen', async t => {
	const invalid = await mount(t, 'https://gp.miku2go.com/fuji3chat?state=bad');
	assert.equal(invalid.requests.length, 0); assert.equal(invalid.navigations.length, 0);
	assert.match(invalid.element.textContent, /failed/);
	const failed = await mount(t, `https://gp.miku2go.com/fuji3chat?state=${state}&code_challenge=${challenge}`, 503);
	assert.equal(failed.navigations.length, 0); assert.match(failed.element.textContent, /retry/);
});


test('room survives an issue failure and retry after query cleanup', async t => {
	const result = await mount(t, `https://gp.miku2go.com/fuji3chat?room=FlGm7uhJ8U&state=${state}&code_challenge=${challenge}`, 503);
	assert.equal(window.location.search, '');
	result.element.querySelector('button').click();
	assert.deepEqual(result.navigations, ['https://chat.misskey.pink/api/auth/fuji3chat/start?room=FlGm7uhJ8U']);
});

test('production room starts at production and invalid room does not issue', async t => {
	const result = await mount(t, 'https://misskey.day/fuji3chat?room=FlGm7uhJ8U');
	assert.deepEqual(result.navigations, ['https://fuji3.top/api/auth/fuji3chat/start?room=FlGm7uhJ8U']);
	const invalid = await mount(t, 'https://misskey.day/fuji3chat?room=https://evil.test');
	assert.equal(invalid.navigations.length, 0);
	assert.equal(invalid.requests.length, 0);
});

const helperSource = await readFile(new URL('../src/utility/fuji3chat-link.ts', import.meta.url), 'utf8');
const { fuji3chatRoomLink } = await import(asModule(ts.transpileModule(helperSource, { compilerOptions: { module: ts.ModuleKind.ES2022 } }).outputText));
for (const [local, chat] of [['https://gp.miku2go.com', 'https://chat.misskey.pink'], ['https://misskey.day', 'https://fuji3.top']]) {
	test(`paired room links: ${local}`, () => {
		for (const suffix of ['', '/']) assert.equal(fuji3chatRoomLink(chat + '/r/FlGm7uhJ8U' + suffix, local, true), chat + '/api/auth/fuji3chat/start?room=FlGm7uhJ8U');
		assert.equal(fuji3chatRoomLink(chat + '/r/FlGm7uhJ8U', local, false), null);
		for (const value of [chat, chat + '/r/short', chat + '/r/FlGm7uhJ8U?next=evil', chat + '/r/FlGm7uhJ8U#fragment', chat + '.evil.test/r/FlGm7uhJ8U', chat.replace('https:', 'http:') + '/r/FlGm7uhJ8U', 'https://chat.streamer.homes/r/FlGm7uhJ8U', chat.replace('https://', 'https://user@') + '/r/FlGm7uhJ8U', 'https://evil.test/r/FlGm7uhJ8U']) assert.equal(fuji3chatRoomLink(value, local, true), null, value);
	});
}
test('cross-environment and unknown issuer do not rewrite', () => {
	assert.equal(fuji3chatRoomLink('https://fuji3.top/r/FlGm7uhJ8U', 'https://gp.miku2go.com', true), null);
	assert.equal(fuji3chatRoomLink('https://chat.misskey.pink/r/FlGm7uhJ8U', 'https://misskey.day', true), null);
	assert.equal(fuji3chatRoomLink('https://fuji3.top/r/FlGm7uhJ8U', 'https://other.test', true), null);
});


for (const file of ['components/global/MkUrl.vue', 'components/MkLink.vue', 'components/MkUrlPreview.vue']) {
	test(`real link component preserves display and uses SSO href: ${file}`, async t => {
		const original = 'https://chat.misskey.pink/r/FlGm7uhJ8U';
		const previewRequests = [];
		window.fetch = async url => { previewRequests.push(url); return { ok: true, json: async () => ({ url: original, title: 'Room preview' }) }; };
		const { descriptor: linkDescriptor } = parse(await readFile(new URL('../src/' + file, import.meta.url), 'utf8'));
		let linkSource = compileScript(linkDescriptor, { id: 'room-link', inlineTemplate: true }).content;
		const stubs = {
			...imports,
			'@@/js/config.js': asModule('export const url="https://gp.miku2go.com"'),
			'@@/js/url.js': asModule('export const maybeMakeRelative=(url)=>url'),
			'@@/js/intl-const.js': asModule('export const versatileLang="ja-JP"'),
			'punycode.js': asModule('export const toUnicode=x=>x'),
			'@/utility/fuji3chat-link.js': asModule(ts.transpileModule(helperSource, { compilerOptions: { module: ts.ModuleKind.ES2022 } }).outputText),
			'@/composables/use-tooltip.js': asModule('export const useTooltip=()=>{}'),
			'@/os.js': asModule('export const popup=()=>{}'),
			'@/utility/url-preview.js': asModule('export const isEnabledUrlPreview={value:false}; export const transformPlayerUrl=x=>x'),
			'@/utility/device-kind.js': asModule('export const deviceKind="desktop"'),
			'@/store.js': asModule('export const store={s:{darkMode:false}}'),
			'@/preferences.js': asModule('export const prefer={s:{dataSaver:{urlPreviewThumbnail:false}}}'),
		};
		for (const [name, url] of Object.entries(stubs)) linkSource = linkSource.replaceAll(`'${name}'`, `'${url}'`).replaceAll(`"${name}"`, `"${url}"`);
		const Component = (await import(asModule(ts.transpileModule(linkSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText))).default;
		const element = document.createElement('div'); document.body.appendChild(element);
		const app = vue.createApp({ render: () => vue.h(Component, { url: original }, () => 'Room label') });
		app.config.globalProperties.$style = {};
		app.component('MkEllipsis', { template: '<span>...</span>' });
		app.mount(element);
		t.after(() => { app.unmount(); element.remove(); });
		await new Promise(resolve => setTimeout(resolve, 20));
		assert.equal(element.querySelector('a').href, 'https://chat.misskey.pink/api/auth/fuji3chat/start?room=FlGm7uhJ8U');
		assert.equal(element.querySelector('a').target, '_blank');
		assert.equal(element.textContent.includes('/api/auth'), false);
		if (file.endsWith('MkUrl.vue')) assert.match(element.textContent, /chat.misskey.pink/);
		if (file.endsWith('MkLink.vue')) assert.match(element.textContent, /Room label/);
		if (file.endsWith('MkUrlPreview.vue')) {
			assert.match(element.textContent, /Room preview/);
			assert.equal(new URL(previewRequests[0], 'https://gp.miku2go.com').searchParams.get('url'), original);
		} else assert.equal(previewRequests.length, 0);
	});
}
