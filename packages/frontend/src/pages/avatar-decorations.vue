<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<MkStickyContainer>
	<template #header><MkPageHeader v-model:tab="tab" :actions="headerActions" :tabs="headerTabs"/></template>
	<MkSpacer :contentMax="900">
		<div class="_gaps">
			<MkFolder v-for="avatarDecoration in avatarDecorations" :key="avatarDecoration.id ?? avatarDecoration._id" :defaultOpen="avatarDecoration.id == null">
				<template #label>{{ avatarDecoration.name }}</template>
				<template #caption>{{ avatarDecoration.description }}</template>

				<div class="_gaps_m">
                                	<div v-if="avatarDecoration.id == null" >
						<MkInput v-model="avatarDecoration.name">
							<template #label>{{ i18n.ts.name }}</template>
						</MkInput>
					</div>
					<MkTextarea v-model="avatarDecoration.description">
						<template #label>{{ i18n.ts.description }}</template>
					</MkTextarea>
                               		<div v-if="avatarDecoration.url != ''" :class="$style.imgs">
                                       		<div style="background: #fff;" :class="$style.imgContainer">
                                                	<img :src="avatarDecoration.url" :class="$style.img"/>
                                        	</div>
                                	</div>
                               		<MkButton rounded style="margin: 0 auto;" @click="changeImage($event,avatarDecoration)">{{ i18n.ts.selectFile }}</MkButton>
<!--------				<MkInput v-model="avatarDecoration.url">
						<template #label>{{ i18n.ts.imageUrl }}</template>
					</MkInput>-------------->

					<div class="buttons _buttons">
						<MkButton class="button" inline primary @click="save(avatarDecoration)"><i class="ti ti-device-floppy"></i> {{ i18n.ts.save }}</MkButton>
						<MkButton v-if="avatarDecoration.id != null" class="button" inline danger @click="del(avatarDecoration)"><i class="ti ti-trash"></i> {{ i18n.ts.delete }}</MkButton>
					</div>
				</div>
			</MkFolder>
		</div>
	</MkSpacer>
</MkStickyContainer>
</template>

<script lang="ts" setup>
import { ref, computed } from 'vue';
import * as Misskey from 'misskey-js';
import MkButton from '@/components/MkButton.vue';
import MkInput from '@/components/MkInput.vue';
import MkTextarea from '@/components/MkTextarea.vue';
import * as os from '@/os.js';
import { misskeyApi } from '@/scripts/misskey-api.js';
import { i18n } from '@/i18n.js';
import { definePageMetadata } from '@/scripts/page-metadata.js';
import MkFolder from '@/components/MkFolder.vue';
import { selectFile } from '@/scripts/select-file.js';

const avatarDecorations = ref<Misskey.entities.AdminAvatarDecorationsListResponse>([]);
let file     = ref<Misskey.entities.DriveFile>();
let file_old = ref<Misskey.entities.DriveFile>();


function add() {
	avatarDecorations.value.unshift({
		_id: Math.random().toString(36),
		id: null,
		name: '',
		description: '',
		url: '',
	});
}

function del(avatarDecoration) {
	os.confirm({
		type: 'warning',
		text: i18n.tsx.deleteAreYouSure({ x: avatarDecoration.name }),
	}).then(({ canceled }) => {
		if (canceled) return;
		avatarDecorations.value = avatarDecorations.value.filter(x => x !== avatarDecoration);
		misskeyApi('admin/avatar-decorations/delete', avatarDecoration);
	});
}

async function changeImage(ev,avatarDecoration) {
	file_old.value = file.value;
        file.value = await selectFile(ev.currentTarget ?? ev.target, "decoration");
	console.log("file = " + file.value.id + " " + file.value.name + " " + file.value.url);
	if( file.value != null && file.value.id != null ){
		if ( file_old.value != null  && file_old.value.id != null ){
        		await os.apiWithDialog('drive/files/delete', {
                		fileId: file_old.value.id,
        		});
		}
		avatarDecoration.url = file.value.url;
        	const candidate = file.value.name.replace(/\.(.+)$/, '');
        	if (candidate.match(/^[a-z0-9_]+$/)) {
			if ( avatarDecoration.name == '' ){
                		avatarDecoration.name = candidate;
			}
		}
	}
}

async function save(avatarDecoration) {
	if (avatarDecoration.id == null) {
		await os.apiWithDialog('admin/avatar-decorations/create', avatarDecoration);
		load();
	} else {
		os.apiWithDialog('admin/avatar-decorations/update', avatarDecoration);
	}
}

function load() {
	misskeyApi('admin/avatar-decorations/list').then(_avatarDecorations => {
		avatarDecorations.value = _avatarDecorations;
	});
}

load();

const headerActions = computed(() => [{
	asFullButton: true,
	icon: 'ti ti-plus',
	text: i18n.ts.add,
	handler: add,
}]);

const headerTabs = computed(() => []);

definePageMetadata(() => ({
	title: i18n.ts.avatarDecorations,
	icon: 'ti ti-sparkles',
}));
</script>

<style lang="scss" module>
.imgs {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
        justify-content: center;
}

.imgContainer {
        padding: 8px;
        border-radius: 6px;
}

.img {
        display: block;
        height: 64px;
        width: 64px;
        object-fit: contain;
}
</style>
