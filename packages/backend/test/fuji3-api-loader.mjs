/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { readFile } from 'node:fs/promises';
import ts from 'typescript';

// Preserve the standalone tests while resolving the routes' runtime helper imports.
export async function loadFuji3Module(name) {
	let source = await readFile(new URL(`../src/server/api/${name}.ts`, import.meta.url), 'utf8');
	if (name !== 'fuji3-ip') {
		const helper = await moduleUrl('fuji3-ip');
		source = source.replace("'./fuji3-ip.js'", JSON.stringify(helper));
	}
	return import(compile(source));
}

async function moduleUrl(name) {
	const source = await readFile(new URL(`../src/server/api/${name}.ts`, import.meta.url), 'utf8');
	return compile(source);
}

function compile(source) {
	const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
	return 'data:text/javascript;base64,' + Buffer.from(compiled.replace("'ipaddr.js'", JSON.stringify(import.meta.resolve('ipaddr.js')))).toString('base64');
}
