/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { reactive } from 'vue';

export const fuji3chatConfig = reactive<{ url: string | null }>({ url: null });
let loading: Promise<void> | null = null;

export function loadFuji3chatConfig(): Promise<void> {
	if (loading) return loading;
	loading = (async () => {
		const controller = new AbortController();
		const timer = window.setTimeout(() => controller.abort(), 10000);
		try {
			const response = await window.fetch('/api/fuji3chat/config', {
				credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
			});
			if (!response.ok) throw new Error('SSO settings unavailable');
			const data: unknown = await response.json();
			if (!data || typeof data !== 'object' || !('url' in data)) throw new Error('Invalid SSO settings');
			if (data.url === null) { fuji3chatConfig.url = null; return; }
			if (typeof data.url !== 'string') throw new Error('Invalid SSO destination');
			const target = new URL(data.url);
			if (target.protocol !== 'https:' || target.origin !== data.url) throw new Error('Invalid SSO destination');
			fuji3chatConfig.url = target.origin;
		} catch (error) {
			fuji3chatConfig.url = null;
			loading = null;
			throw error;
		} finally {
			window.clearTimeout(timer);
		}
	})();
	return loading;
}

void loadFuji3chatConfig().catch(() => {});
