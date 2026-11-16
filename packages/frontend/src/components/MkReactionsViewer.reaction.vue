<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<button
	ref="buttonEl"
	v-ripple="canToggle || isRemoteCustomEmoji"
	class="_button"
	:class="[$style.root, { [$style.reacted]: myReaction == reaction, [$style.canToggle]: canToggle || isRemoteCustomEmoji, [$style.small]: prefer.s.reactionsDisplaySize === 'small', [$style.large]: prefer.s.reactionsDisplaySize === 'large' }]"
	@click="toggleReaction($event)"
	@contextmenu.prevent.stop="menu"
>
	<MkReactionIcon style="pointer-events: none;" :class="prefer.s.limitWidthOfReaction ? $style.limitWidth : ''" :reaction="reaction" :emojiUrl="reactionEmojis[emojiName]"/>
	<span :class="$style.count">{{ count }}</span>
</button>
</template>

<script lang="ts" setup>
import { computed, inject, onMounted, useTemplateRef, watch } from 'vue';
import * as Misskey from 'misskey-js';
import { getUnicodeEmojiOrNull } from '@@/js/emojilist.js';
import { getEmojiNameFromReaction, isLocalCustomEmojiReaction } from '@@/js/emoji-name.js';
import MkCustomEmojiDetailedDialog from './MkCustomEmojiDetailedDialog.vue';
import type { MenuItem } from '@/types/menu';
import XDetails from '@/components/MkReactionsViewer.details.vue';
import MkReactionIcon from '@/components/MkReactionIcon.vue';
import * as os from '@/os.js';
import { misskeyApi, misskeyApiGet } from '@/utility/misskey-api.js';
import { useTooltip } from '@/composables/use-tooltip.js';
import { $i } from '@/i.js';
import MkReactionEffect from '@/components/MkReactionEffect.vue';
import { i18n } from '@/i18n.js';
import * as sound from '@/utility/sound.js';
// import { checkReactionPermissions } from '@/utility/check-reaction-permissions.js';
import { customEmojis, customEmojisMap, fetchCustomEmojis } from '@/custom-emojis.js';
import { prefer } from '@/preferences.js';
import { DI } from '@/di.js';
import { noteEvents } from '@/composables/use-note-capture.js';
import { mute as muteEmoji, unmute as unmuteEmoji, checkMuted as isEmojiMuted } from '@/utility/emoji-mute.js';
import { addToEmojiPalette } from '@/utility/emoji-palette.js';
import { haptic } from '@/utility/haptic.js';

const props = defineProps<{
	noteId: Misskey.entities.Note['id'];
	reaction: string;
	reactionEmojis: Misskey.entities.Note['reactionEmojis'];
	myReaction: Misskey.entities.Note['myReaction'];
	count: number;
	isInitial: boolean;
}>();

const mock = inject(DI.mock, false);

const emit = defineEmits<{
	(ev: 'reactionToggled', emoji: string, newCount: number): void;
}>();

const buttonEl = useTemplateRef('buttonEl');

const emojiName = computed(() => getEmojiNameFromReaction(props.reaction));

const isLocalCustomEmoji = computed(() => isLocalCustomEmojiReaction(props.reaction));
const isRemoteCustomEmoji = computed(() => (
	props.reaction.startsWith(':') &&
	props.reaction.includes('@') &&
	!isLocalCustomEmoji.value
));

// getEmojiNameFromReaction() はリモート絵文字の場合に「name@host」を返すため、
// 同名のローカル絵文字を探すときはホスト部分を除いた名前を使う。
const localAlternativeEmojiName = computed(() => {
	const name = emojiName.value;
	const hostSeparatorIndex = name.indexOf('@');
	return hostSeparatorIndex === -1 ? name : name.slice(0, hostSeparatorIndex);
});

// リモート絵文字と同名のローカル絵文字がある場合、その絵文字でリアクションする。
// customEmojis.value を参照することで、絵文字インポート後の一覧更新を computed が検知できるようにする。
const alternativeEmoji = computed(() => {
	if (!isRemoteCustomEmoji.value) return undefined;

	return customEmojis.value.find(emoji => emoji.name === localAlternativeEmojiName.value);
});

const canToggle = computed(() => {
	const emoji = isLocalCustomEmoji.value ? customEmojisMap.get(emojiName.value) : getUnicodeEmojiOrNull(props.reaction);

	// TODO
	//return $i != null && emoji != null && checkReactionPermissions($i, props.note, emoji);
	return $i != null && emoji != null;
});

async function toggleReaction(ev?: MouseEvent) {
	if (!canToggle.value) {
		if (isRemoteCustomEmoji.value && ev != null && $i != null) {
			chooseAlternative(ev);
		}
		return;
	}
	if ($i == null) return;

	const me = $i;

	const oldReaction = props.myReaction;
	if (oldReaction) {
		const confirm = await os.confirm({
			type: 'warning',
			text: oldReaction !== props.reaction ? i18n.ts.changeReactionConfirm : i18n.ts.cancelReactionConfirm,
		});
		if (confirm.canceled) return;

		if (oldReaction !== props.reaction) {
			sound.playMisskeySfx('reaction');
			haptic();
		}

		if (mock) {
			emit('reactionToggled', props.reaction, (props.count - 1));
			return;
		}

		misskeyApi('notes/reactions/delete', {
			noteId: props.noteId,
		}).then(() => {
			noteEvents.emit(`unreacted:${props.noteId}`, {
				userId: me.id,
				reaction: oldReaction,
			});
			if (oldReaction !== props.reaction) {
				misskeyApi('notes/reactions/create', {
					noteId: props.noteId,
					reaction: props.reaction,
				}).then(() => {
					const emoji = customEmojisMap.get(emojiName.value);
					if (emoji == null && getUnicodeEmojiOrNull(props.reaction) == null) {
						return;
					}
					noteEvents.emit(`reacted:${props.noteId}`, {
						userId: me.id,
						reaction: props.reaction,
						emoji: emoji,
					});
				});
			}
		});
	} else {
		if (prefer.s.confirmOnReact) {
			const confirm = await os.confirm({
				type: 'question',
				text: i18n.tsx.reactAreYouSure({ emoji: props.reaction.replace('@.', '') }),
			});

			if (confirm.canceled) return;
		}

		sound.playMisskeySfx('reaction');
		haptic();

		if (mock) {
			emit('reactionToggled', props.reaction, (props.count + 1));
			return;
		}

		misskeyApi('notes/reactions/create', {
			noteId: props.noteId,
			reaction: props.reaction,
		}).then(() => {
			const emoji = customEmojisMap.get(emojiName.value);
			if (emoji == null && getUnicodeEmojiOrNull(props.reaction) == null) {
				return;
			}

			noteEvents.emit(`reacted:${props.noteId}`, {
				userId: me.id,
				reaction: props.reaction,
				emoji: emoji,
			});
		});
		// TODO: 上位コンポーネントでやる
		//if (props.note.text && props.note.text.length > 100 && (Date.now() - new Date(props.note.createdAt).getTime() < 1000 * 3)) {
		//	claimAchievement('reactWithoutRead');
		//}
	}
}

async function menu(ev: PointerEvent) {
	let menuItems: MenuItem[] = [];

	if (isLocalCustomEmoji.value) {
		menuItems.push({
			text: i18n.ts.info,
			icon: 'ti ti-info-circle',
			action: async () => {
				const { dispose } = os.popup(MkCustomEmojiDetailedDialog, {
					emoji: await misskeyApiGet('emoji', {
						name: emojiName.value,
					}),
				}, {
					closed: () => dispose(),
				});
			},
		});
	}

	if (isEmojiMuted(props.reaction).value) {
		menuItems.push({
			text: i18n.ts.emojiUnmute,
			icon: 'ti ti-mood-smile',
			action: () => {
				os.confirm({
					type: 'question',
					title: i18n.tsx.unmuteX({ x: isLocalCustomEmoji.value ? `:${emojiName.value}:` : props.reaction }),
				}).then(({ canceled }) => {
					if (canceled) return;
					unmuteEmoji(props.reaction);
				});
			},
		});
	} else {
		menuItems.push({
			text: i18n.ts.emojiMute,
			icon: 'ti ti-mood-off',
			action: () => {
				os.confirm({
					type: 'question',
					title: i18n.tsx.muteX({ x: isLocalCustomEmoji.value ? `:${emojiName.value}:` : props.reaction }),
				}).then(({ canceled }) => {
					if (canceled) return;
					muteEmoji(props.reaction);
				});
			},
		});
	}

	if (canToggle.value) {
		menuItems.push({
			text: i18n.ts.addToEmojiPalette,
			icon: 'ti ti-palette',
			action: () => {
				addToEmojiPalette(isLocalCustomEmoji.value ? `:${emojiName.value}:` : props.reaction);
			},
		});
	}

	os.popupMenu(menuItems, ev.currentTarget ?? ev.target);
}

async function importRemoteEmoji(emojiId: string) {
	await os.apiWithDialog('admin/emoji/copy', {
		emojiId,
	});

	// インポート直後にローカル絵文字一覧を強制再取得する。
	// これによりページ再読み込みなしで、次回クリック時に同名のローカル絵文字を認識できる。
	await fetchCustomEmojis(true);
}

function showRemoteEmojiMenu(emojiId: string, ev: MouseEvent) {
	os.popupMenu([{
		type: 'label',
		text: props.reaction,
	}, {
		text: i18n.ts.import,
		icon: 'ti ti-plus',
		action: () => {
			void importRemoteEmoji(emojiId);
		},
	}], ev.currentTarget ?? ev.target);
}

function chooseAlternative(ev: MouseEvent) {
	const me = $i;
	if (me == null) return;

	const alternative = alternativeEmoji.value;
	if (alternative == null) {
		showRemoteEmojiMenu(props.reaction, ev);
		return;
	}

	const reaction = `:${alternative.name}:`;
	void misskeyApi('notes/reactions/create', {
		noteId: props.noteId,
		reaction,
	}).then(() => {
		noteEvents.emit(`reacted:${props.noteId}`, {
			userId: me.id,
			reaction,
			emoji: alternative,
		});
	});
}

function anime() {
	if (window.document.hidden || !prefer.s.animation || buttonEl.value == null) return;

	const rect = buttonEl.value.getBoundingClientRect();
	const x = rect.left + 16;
	const y = rect.top + (buttonEl.value.offsetHeight / 2);
	const { dispose } = os.popup(MkReactionEffect, { reaction: props.reaction, x, y }, {
		end: () => dispose(),
	});
}

watch(() => props.count, (newCount, oldCount) => {
	if (oldCount < newCount) anime();
});

onMounted(() => {
	if (!props.isInitial) anime();
});

if (!mock) {
	useTooltip(buttonEl, async (showing) => {
		if (buttonEl.value == null) return;

		const reactions = await misskeyApi('notes/reactions', {
			noteId: props.noteId,
			type: props.reaction,
			limit: 10,
		});

		const users = reactions.map(x => x.user);

		const { dispose } = os.popup(XDetails, {
			showing,
			reaction: props.reaction,
			users,
			count: props.count,
			anchorElement: buttonEl.value,
		}, {
			closed: () => dispose(),
		});
	}, 100);
}
</script>

<style lang="scss" module>
.root {
	display: inline-flex;
	height: 42px;
	padding: 0 6px;
	font-size: 1.5em;
	border-radius: 6px;
	align-items: center;
	justify-content: center;

	&.canToggle {
		background: var(--MI_THEME-buttonBg);

		&:hover {
			background: rgba(0, 0, 0, 0.1);
		}
	}

	&:not(.canToggle) {
		cursor: default;
	}

	&.small {
		height: 32px;
		font-size: 1em;
		border-radius: 4px;

		> .count {
			font-size: 0.9em;
			line-height: 32px;
		}
	}

	&.large {
		height: 52px;
		font-size: 2em;
		border-radius: 8px;

		> .count {
			font-size: 0.6em;
			line-height: 52px;
		}
	}

	&.reacted, &.reacted:hover {
		background: var(--MI_THEME-accentedBg);
		color: var(--MI_THEME-accent);
		box-shadow: 0 0 0 1px var(--MI_THEME-accent) inset;

		> .count {
			color: var(--MI_THEME-accent);
		}

		> .icon {
			filter: drop-shadow(0 0 2px rgba(0, 0, 0, 0.5));
		}
	}
}

.limitWidth {
	max-width: 70px;
	object-fit: contain;
}

.count {
	font-size: 0.7em;
	line-height: 42px;
	margin: 0 0 0 4px;
}
</style>
