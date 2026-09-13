/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
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
