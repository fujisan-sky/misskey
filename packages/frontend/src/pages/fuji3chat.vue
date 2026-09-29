<!--
SPDX-FileCopyrightText: mikop and fujisansky-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<MkSpacer :contentMax="600">
	<div class="_gaps">
		<p role="status" aria-live="polite">{{ failed ? i18n.ts._fuji3chat.failed : i18n.ts._fuji3chat.connecting }}</p>
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

const destinations: Record<string, string> = {
	'https://gp.miku2go.com': 'https://chat.misskey.pink',
	'https://misskey.day': 'https://fuji3.top',
};
const destination = destinations[window.location.origin];
const room = new URLSearchParams(window.location.search).get('room') ?? '';
const validRoom = !room || /^[A-Za-z0-9]{10}$/.test(room);
const failed = ref(false);
const controller = new AbortController();
onBeforeUnmount(() => controller.abort());

function restart() {
	if (destination && validRoom) window.location.replace(destination + '/api/auth/fuji3chat/start' + (room ? '?room=' + room : ''));
	else failed.value = true;
}

onMounted(async () => {
	if (!$i || !destination || !validRoom) { failed.value = true; return; }
	const params = new URLSearchParams(window.location.search);
	const state = params.get('state');
	const codeChallenge = params.get('code_challenge');
	if (!state && !codeChallenge) { restart(); return; }
	if (!state || !codeChallenge || !/^[A-Za-z0-9_-]{43}$/.test(state) || !/^[A-Za-z0-9_-]{43}$/.test(codeChallenge)) {
		failed.value = true;
		return;
	}
	window.history.replaceState(window.history.state, '', '/fuji3chat');
	const timer = window.setTimeout(() => controller.abort(), 15000);
	try {
		const response = await window.fetch('/api/fuji3chat/issue', {
			method: 'POST', credentials: 'same-origin', signal: controller.signal,
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ i: $i.token, state, codeChallenge }),
		});
		if (!response.ok) throw new Error();
		const data: unknown = await response.json();
		if (!data || typeof data !== 'object' || !('code' in data) || typeof data.code !== 'string'
			|| !/^[A-Za-z0-9_-]{43}$/.test(data.code)) throw new Error();
		if (controller.signal.aborted) return;
		const callback = new URL('/api/auth/fuji3chat/callback', destination);
		callback.searchParams.set('code', data.code);
		callback.searchParams.set('state', state);
		window.location.replace(callback.href);
	} catch {
		failed.value = true;
	} finally {
		window.clearTimeout(timer);
	}
});

definePage(() => ({ title: i18n.ts._fuji3chat.title, icon: 'ti ti-palette' }));
</script>
