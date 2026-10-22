<!--
SPDX-FileCopyrightText: mikop and fujisky-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<MkSpacer :contentMax="600">
	<div class="_gaps">
		<p role="status" aria-live="polite">{{ failed ? i18n.ts._fuji3qa.failed : i18n.ts._fuji3qa.connecting }}</p>
		<MkButton v-if="failed" primary @click="restart">{{ i18n.ts.retry }}</MkButton>
	</div>
</MkSpacer>
</template>

<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from 'vue';
import MkButton from '@/components/MkButton.vue';
import { $i } from '@/i.js';
import { i18n } from '@/i18n.js';
import { definePage } from '@/page.js';
import { fuji3qaConfig, loadFuji3qaConfig } from '@/utility/fuji3qa-config.js';

const room = new URLSearchParams(window.location.search).get('room') ?? '';
const validRoom = !room || /^[A-Za-z0-9]{10}$/.test(room);
const failed = ref(false);
const controller = new AbortController();
onBeforeUnmount(() => controller.abort());

async function restart() {
	try {
		await loadFuji3qaConfig();
		if (controller.signal.aborted) return;
		if (!fuji3qaConfig.url || !validRoom) throw new Error();
		const start = new URL('/api/auth/fuji3qa/start', fuji3qaConfig.url);
		start.searchParams.set('host', window.location.hostname);
		if (room) start.searchParams.set('room', room);
		window.location.replace(start.href);
	} catch {
		failed.value = true;
	}
}

onMounted(async () => {
	try { await loadFuji3qaConfig(); } catch { failed.value = true; return; }
	const destination = fuji3qaConfig.url;
	if (controller.signal.aborted) return;
	if (!$i || !destination || !validRoom) { failed.value = true; return; }
	const params = new URLSearchParams(window.location.search);
	const state = params.get('state');
	const codeChallenge = params.get('code_challenge');
	if (!state && !codeChallenge) { restart(); return; }
	if (!state || !codeChallenge || !/^[A-Za-z0-9_-]{43}$/.test(state) || !/^[A-Za-z0-9_-]{43}$/.test(codeChallenge)) {
		failed.value = true;
		return;
	}
	window.history.replaceState(window.history.state, '', '/fuji3qa');
	const timer = window.setTimeout(() => controller.abort(), 15000);
	try {
		const response = await window.fetch('/api/fuji3qa/issue', {
			method: 'POST', credentials: 'same-origin', signal: controller.signal,
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ i: $i.token, state, codeChallenge }),
		});
		if (!response.ok) throw new Error();
		const data: unknown = await response.json();
		if (!data || typeof data !== 'object' || !('code' in data) || typeof data.code !== 'string'
			|| !/^[A-Za-z0-9_-]{43}$/.test(data.code)) throw new Error();
		if (controller.signal.aborted) return;
		const callback = new URL('/api/auth/fuji3qa/callback', destination);
		callback.searchParams.set('code', data.code);
		callback.searchParams.set('state', state);
		window.location.replace(callback.href);
	} catch {
		failed.value = true;
	} finally {
		window.clearTimeout(timer);
	}
});

definePage(() => ({ title: i18n.ts._fuji3qa.title, icon: '_fuji3qaIcon' }));
</script>
