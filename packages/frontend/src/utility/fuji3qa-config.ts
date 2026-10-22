/*
 * SPDX-FileCopyrightText: mikop and fujiskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { reactive } from 'vue';

export const fuji3qaConfig = reactive<{ url: string | null }>({ url: null });
let loading: Promise<void> | null = null;

export function loadFuji3qaConfig(): Promise<void> {
	if (loading) return loading;
	loading = (async () => {
		const controller = new AbortController();
		const timer = window.setTimeout(() => controller.abort(), 10000);
		try {
			const response = await window.fetch('/api/fuji3qa/config', {
				credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
			});
			if (!response.ok) throw new Error('SSO settings unavailable');
			const data: unknown = await response.json();
			if (!data || typeof data !== 'object' || !('url' in data)) throw new Error('Invalid SSO settings');
			if (data.url === null) { fuji3qaConfig.url = null; return; }
			if (typeof data.url !== 'string') throw new Error('Invalid SSO destination');
			const target = new URL(data.url);
			if (target.protocol !== 'https:' || target.origin !== data.url) throw new Error('Invalid SSO destination');
			fuji3qaConfig.url = target.origin;
		} catch (error) {
			fuji3qaConfig.url = null;
			loading = null;
			throw error;
		} finally {
			window.clearTimeout(timer);
		}
	})();
	return loading;
}

void loadFuji3qaConfig().catch(() => {});
