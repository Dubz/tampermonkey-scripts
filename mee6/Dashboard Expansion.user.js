// ==UserScript==
// @name         MEE6 - Dashboard Expansion
// @namespace    http://github.com/Dubz/
// @downloadURL  https://raw.githubusercontent.com/Dubz/tampermonkey-scripts/refs/heads/main/mee6/Dashboard%20Expansion.user.js
// @updateURL    https://raw.githubusercontent.com/Dubz/tampermonkey-scripts/refs/heads/main/mee6/Dashboard%20Expansion.user.js
// @version      2026.1007.2018
// @description  Extends MEE6 setting controls while validating values against Discord capabilities
// @author       Dubz (dubzz. <@284859960070766602>)
// @homepage     https://github.com/Dubz/tampermonkey-scripts/mee6/Dashboard%20Expansion.user.js
// @match        https://mee6.xyz/*
// @icon         none
// @connect      discord.com
// @run-at       document-start
// @grant        GM.xmlHttpRequest
// @grant        GM.getValue
// @grant        GM.setValue
// ==/UserScript==

(function(){
	'use strict';

	const CONFIG = {
		debug: true,

		cache: {
			guildCapabilityTtl: 24 * 60 * 60 * 1000
		},

		discord: {
			apiBase: 'https://discord.com/api/v10',

			bitrateByTier: {
				0: 96,
				1: 128,
				2: 256,
				3: 384
			},

			tierFromBoostCount(count){
				count = Number(count);

				if(!Number.isInteger(count) || count < 0){
					return null;
				}

				if(count >= 14){
					return 3;
				}

				if(count >= 7){
					return 2;
				}

				if(count >= 2){
					return 1;
				}

				return 0;
			}
		},

		pages: [
			{
				id: 'temporary-channel-edition',
				url: /^\/[a-z-]+\/dashboard\/(?<guildId>\d+)\/temporary_channels\/(?<channelId>\d+)\/edition\/?$/i,

				requests: [
					/temporary_channels/i
				],

				settings: [
					{
						id: 'bitrate',
						label: 'Bitrate',

						payloadPaths: [
							['bitrate']
						],

						type: 'integer-range',
						min: 8,
						max: 384,
						step: 1,
						unit: 'kbps',

						getEffectiveMax(context){
							return context.guild.capabilities.voiceBitrateMax;
						},

						showLimitMarker: true,
						showBlockedRegion: true
					}
				]
			}
		]
	};

	const STATE = {
		page: null,
		pageKey: null,
		settingValues: new Map(),
		apiSnapshots: [],

		guild: {
			id: null,
			tier: null,
			boosts: null,

			capabilities: {
				voiceBitrateMax: null
			},

			status: 'unknown',
			source: null,
			fetchedAt: null
		},

		capabilityRequest: null
	};

	function debug(...args){
		if(CONFIG.debug){
			console.debug('[MEE6 Extended Settings]', ...args);
		}
	}

	function warn(...args){
		console.warn('[MEE6 Extended Settings]', ...args);
	}

	/**********************************************************************
	 * Styles
	 **********************************************************************/

	function installStyles(){
		if(document.getElementById('mee6-extended-settings-style')){
			return;
		}

		const style = document.createElement('style');
		style.id = 'mee6-extended-settings-style';

		style.textContent = `
			.mee6-extended-range {
				appearance: none;
				-webkit-appearance: none;
				width: 100%;
				height: 16px;
				margin: 0;
				padding: 0;
				background: transparent;
				cursor: pointer;
			}

			.mee6-extended-range:focus {
				outline: none;
			}

			.mee6-extended-range:disabled {
				cursor: wait;
				opacity: 0.6;
			}

			.mee6-extended-range::-webkit-slider-runnable-track {
				height: 6px;
				border: 0;
				border-radius: 9999px;
				background: linear-gradient(
					to right,
					#3994ff 0%,
					#3994ff var(--mee6-value-percent, 0%),
					#2e303a var(--mee6-value-percent, 0%),
					#2e303a 100%
				);
			}

			.mee6-extended-range::-webkit-slider-thumb {
				appearance: none;
				-webkit-appearance: none;
				width: 16px;
				height: 16px;
				margin-top: -5px;
				border: 0;
				border-radius: 50%;
				background: #d0d0d0;
				box-shadow: 0 1px 3px rgba(0, 0, 0, 0.45);
				cursor: pointer;
			}

			.mee6-extended-range:hover::-webkit-slider-thumb {
				background: #ffffff;
			}

			.mee6-extended-range:focus-visible::-webkit-slider-thumb {
				outline: 2px solid #3994ff;
				outline-offset: 2px;
			}

			.mee6-extended-range::-moz-range-track {
				height: 6px;
				border: 0;
				border-radius: 9999px;
				background: #2e303a;
			}

			.mee6-extended-range::-moz-range-progress {
				height: 6px;
				border: 0;
				border-radius: 9999px;
				background: #3994ff;
			}

			.mee6-extended-range::-moz-range-thumb {
				width: 16px;
				height: 16px;
				border: 0;
				border-radius: 50%;
				background: #d0d0d0;
				box-shadow: 0 1px 3px rgba(0, 0, 0, 0.45);
				cursor: pointer;
			}

			.mee6-extended-range:hover::-moz-range-thumb {
				background: #ffffff;
			}

			.mee6-extended-number {
				color-scheme: dark;
			}

			.mee6-extended-number:disabled {
				cursor: wait;
				opacity: 0.6;
			}

			.mee6-extended-refresh:disabled {
				cursor: default !important;
				opacity: 0.5;
			}
		`;

		(document.head || document.documentElement).appendChild(style);
	}

	/**********************************************************************
	 * Page state
	 **********************************************************************/

	function resolvePage(){
		for(const page of CONFIG.pages){
			const match = location.pathname.match(page.url);

			if(match){
				return {
					config: page,
					params: {...(match.groups || {})}
				};
			}
		}

		return null;
	}

	function makePageKey(page){
		if(!page){
			return null;
		}

		return `${page.config.id}:${JSON.stringify(page.params)}`;
	}

	function updatePage(){
		const page = resolvePage();
		const pageKey = makePageKey(page);

		if(pageKey === STATE.pageKey){
			STATE.page = page;
			return;
		}

		const previousGuildId = STATE.guild.id;

		STATE.page = page;
		STATE.pageKey = pageKey;
		STATE.settingValues.clear();
		STATE.guild.id = page?.params?.guildId || null;

		if(!STATE.guild.id){
			resetGuildCapability('unknown');
			refreshControls();
			return;
		}

		if(STATE.guild.id !== previousGuildId){
			resetGuildCapability('loading');
			void resolveGuildCapability();
		}

		replayObservedPageSettings();
		refreshControls();
	}

	function currentSettings(){
		return STATE.page?.config?.settings || [];
	}

	function pageAllowsRequest(page, url){
		const rules = page?.requests;

		if(!page){
			return false;
		}

		if(!rules?.length){
			return true;
		}

		return rules.some(rule => {
			if(rule instanceof RegExp){
				rule.lastIndex = 0;
				return rule.test(String(url));
			}

			return String(url).includes(String(rule));
		});
	}

	function currentPageAllowsRequest(url){
		return pageAllowsRequest(STATE.page?.config, url);
	}

	function configuredPageAllowsRequest(url){
		return CONFIG.pages.some(page => pageAllowsRequest(page, url));
	}

	/**********************************************************************
	 * Per-setting runtime state
	 **********************************************************************/

	function getSettingRuntime(setting){
		let runtime = STATE.settingValues.get(setting.id);

		if(!runtime){
			runtime = {
				serverValue: null,
				overrideValue: null,
				touched: false,
				resolved: false,
				source: null
			};

			STATE.settingValues.set(setting.id, runtime);
		}

		return runtime;
	}

	function setServerSettingValue(setting, value, source){
		const runtime = getSettingRuntime(setting);
		const number = Number(value);

		if(!Number.isFinite(number)){
			return false;
		}

		runtime.serverValue = number;
		runtime.resolved = true;
		runtime.source = source;

		if(runtime.touched && runtime.overrideValue === number){
			runtime.overrideValue = null;
			runtime.touched = false;
		}

		refreshControls();

		debug('MEE6 setting hydrated', setting.id, number, source);

		return true;
	}

	function setUserOverride(setting, value){
		const runtime = getSettingRuntime(setting);

		runtime.overrideValue = value;
		runtime.touched = true;

		refreshControls();
	}

	function getDisplayedSettingValue(setting){
		const runtime = getSettingRuntime(setting);

		if(runtime.overrideValue !== null){
			return runtime.overrideValue;
		}

		return runtime.serverValue;
	}

	/**********************************************************************
	 * GM HTTP and guild cache
	 **********************************************************************/

	function gmRequestJson(url){
		return new Promise((resolve, reject) => {
			GM.xmlHttpRequest({
				method: 'GET',
				url,
				headers: {
					Accept: 'application/json'
				},
				anonymous: false,
				timeout: 10000,

				onload(response){
					if(response.status < 200 || response.status >= 300){
						reject(new Error(`HTTP ${response.status}`));
						return;
					}

					try{
						resolve(JSON.parse(response.responseText));
					}
					catch(error){
						reject(error);
					}
				},

				onerror(){
					reject(new Error('Network request failed'));
				},

				ontimeout(){
					reject(new Error('Network request timed out'));
				}
			});
		});
	}

	function guildCacheKey(guildId){
		return `mee6-extended:guild-capability:${guildId}`;
	}

	async function getCachedGuildCapability(guildId){
		const record = await GM.getValue(guildCacheKey(guildId), null);

		if(!record || typeof record !== 'object'){
			return null;
		}

		const fetchedAt = Number(record.fetchedAt || 0);
		const age = Date.now() - fetchedAt;

		if(!Number.isFinite(age) || age < 0 || age > CONFIG.cache.guildCapabilityTtl){
			return null;
		}

		if(!validateCapability(record.data)){
			return null;
		}

		return {
			...record.data,
			fetchedAt
		};
	}

	async function setCachedGuildCapability(guildId, data){
		if(!validateCapability(data)){
			return;
		}

		await GM.setValue(guildCacheKey(guildId), {
			fetchedAt: Date.now(),
			data
		});
	}

	/**********************************************************************
	 * Guild capability
	 **********************************************************************/

	function validateCapability(data){
		if(!data || typeof data !== 'object'){
			return false;
		}

		const voiceBitrateMax = data.capabilities?.voiceBitrateMax;

		if(!Number.isInteger(voiceBitrateMax) || voiceBitrateMax < 96 || voiceBitrateMax > 384){
			return false;
		}

		if(data.tier !== null && (!Number.isInteger(data.tier) || data.tier < 0 || data.tier > 3)){
			return false;
		}

		return true;
	}

	function resetGuildCapability(status = 'loading'){
		STATE.guild.tier = null;
		STATE.guild.boosts = null;
		STATE.guild.capabilities.voiceBitrateMax = null;
		STATE.guild.status = status;
		STATE.guild.source = null;
		STATE.guild.fetchedAt = null;
	}

	function applyGuildCapability(capability){
		if(!validateCapability(capability)){
			return false;
		}

		STATE.guild.tier = capability.tier;
		STATE.guild.boosts = capability.boosts ?? null;
		STATE.guild.capabilities.voiceBitrateMax = capability.capabilities.voiceBitrateMax;
		STATE.guild.status = 'detected';
		STATE.guild.source = capability.source || null;
		STATE.guild.fetchedAt = capability.fetchedAt || Date.now();

		refreshControls();

		debug('Guild capability updated', {
			guildId: STATE.guild.id,
			tier: STATE.guild.tier,
			boosts: STATE.guild.boosts,
			voiceBitrateMax: STATE.guild.capabilities.voiceBitrateMax,
			source: STATE.guild.source
		});

		return true;
	}

	function capabilityFromTier(tier, source, extra = {}){
		tier = Number(tier);

		if(!Number.isInteger(tier) || tier < 0 || tier > 3){
			return null;
		}

		return {
			tier,
			boosts: extra.boosts ?? null,

			capabilities: {
				voiceBitrateMax: CONFIG.discord.bitrateByTier[tier]
			},

			source
		};
	}

	function capabilityFromBoostCount(boosts, source){
		boosts = Number(boosts);

		if(!Number.isInteger(boosts) || boosts < 0){
			return null;
		}

		const tier = CONFIG.discord.tierFromBoostCount(boosts);

		if(tier === null){
			return null;
		}

		return capabilityFromTier(tier, source, {boosts});
	}

	async function lookupDiscordUserGuild(guildId){
		try{
			const guilds = await gmRequestJson(`${CONFIG.discord.apiBase}/users/@me/guilds`);

			if(!Array.isArray(guilds)){
				return null;
			}

			const guild = guilds.find(item => String(item?.id) === String(guildId));

			if(!guild){
				return null;
			}

			if(guild.premium_tier !== undefined){
				return capabilityFromTier(guild.premium_tier, 'discord-user-guilds');
			}

			if(guild.premium_subscription_count !== undefined){
				return capabilityFromBoostCount(guild.premium_subscription_count, 'discord-user-guilds');
			}

			return null;
		}
		catch(error){
			debug('Discord user guild lookup failed', error.message);
			return null;
		}
	}

	function extractInviteCode(url){
		if(!url){
			return null;
		}

		try{
			const parsed = new URL(url);
			const parts = parsed.pathname.split('/').filter(Boolean);

			return parts[parts.length - 1] || null;
		}
		catch{
			return null;
		}
	}

	async function lookupDiscordWidgetInvite(guildId){
		try{
			const widget = await gmRequestJson(`${CONFIG.discord.apiBase}/guilds/${guildId}/widget.json`);
			const inviteCode = extractInviteCode(widget?.instant_invite);

			if(!inviteCode){
				return null;
			}

			const invite = await gmRequestJson(
				`${CONFIG.discord.apiBase}/invites/${encodeURIComponent(inviteCode)}?with_counts=true`
			);

			if(String(invite?.guild?.id) !== String(guildId)){
				return null;
			}

			if(invite.guild.premium_tier !== undefined){
				return capabilityFromTier(invite.guild.premium_tier, 'discord-public-invite');
			}

			if(invite.guild.premium_subscription_count !== undefined){
				return capabilityFromBoostCount(
					invite.guild.premium_subscription_count,
					'discord-public-invite'
				);
			}

			return null;
		}
		catch(error){
			debug('Discord widget/invite lookup failed', error.message);
			return null;
		}
	}

	async function resolveGuildCapability({force = false} = {}){
		const guildId = STATE.guild.id;

		if(!guildId){
			return null;
		}

		if(STATE.capabilityRequest && !force){
			return STATE.capabilityRequest;
		}

		const request = (async() => {
			STATE.guild.status = 'loading';
			STATE.guild.capabilities.voiceBitrateMax = null;
			refreshControls();

			if(!force){
				const cached = await getCachedGuildCapability(guildId);

				if(cached){
					if(String(STATE.guild.id) === String(guildId)){
						applyGuildCapability(cached);
					}

					return cached;
				}
			}

			const providers = [
				lookupDiscordUserGuild,
				lookupDiscordWidgetInvite
			];

			for(const provider of providers){
				if(String(STATE.guild.id) !== String(guildId)){
					return null;
				}

				const capability = await provider(guildId);

				if(!capability){
					continue;
				}

				await setCachedGuildCapability(guildId, capability);

				if(String(STATE.guild.id) === String(guildId)){
					applyGuildCapability(capability);
				}

				return capability;
			}

			if(String(STATE.guild.id) === String(guildId)){
				STATE.guild.tier = null;
				STATE.guild.boosts = null;
				STATE.guild.capabilities.voiceBitrateMax = 96;
				STATE.guild.status = 'fallback';
				STATE.guild.source = null;
				STATE.guild.fetchedAt = Date.now();

				refreshControls();
			}

			return null;
		})();

		STATE.capabilityRequest = request;

		try{
			return await request;
		}
		finally{
			if(STATE.capabilityRequest === request){
				STATE.capabilityRequest = null;
			}
		}
	}

	/**********************************************************************
	 * MEE6 API response setting hydration
	 **********************************************************************/

	function getObjectIdentity(object){
		if(!object || typeof object !== 'object'){
			return null;
		}

		return object.id ??
			object.channel_id ??
			object.channelId ??
			object.temporary_channel_id ??
			object.temporaryChannelId ??
			null;
	}

	function findSettingValueInResponse(data, setting){
		const channelId = STATE.page?.params?.channelId;
		const candidates = [];
		const seen = new WeakSet();

		function walk(value, depth = 0, inheritedIdentity = null){
			if(!value || typeof value !== 'object' || depth > 20 || seen.has(value)){
				return;
			}

			seen.add(value);

			const ownIdentity = Array.isArray(value) ? null : getObjectIdentity(value);
			const identity = ownIdentity ?? inheritedIdentity;

			if(!Array.isArray(value)){
				for(const path of setting.payloadPaths || []){
					const field = path[path.length - 1];

					if(!Object.prototype.hasOwnProperty.call(value, field)){
						continue;
					}

					const numeric = Number(value[field]);

					if(!Number.isFinite(numeric)){
						continue;
					}

					const identityMatched =
						identity !== null &&
						channelId &&
						String(identity) === String(channelId);

					let score = 0;

					if(identityMatched){
						score += 100;
					}

					if(depth === 0){
						score += 25;
					}

					if(Object.keys(value).some(key => /temporary|channel/i.test(key))){
						score += 5;
					}

					candidates.push({
						value: numeric,
						field,
						score,
						depth,
						identity,
						identityMatched
					});
				}
			}

			const children = Array.isArray(value) ? value : Object.values(value);

			for(const child of children){
				if(child && typeof child === 'object'){
					walk(child, depth + 1, identity);
				}
			}
		}

		walk(data);

		if(!candidates.length){
			return null;
		}

		if(channelId){
			const matched = candidates.filter(candidate => candidate.identityMatched);

			if(matched.length){
				candidates.length = 0;
				candidates.push(...matched);
			}
			else if(candidates.some(candidate => candidate.identity !== null)){
				return null;
			}
		}

		candidates.sort((a, b) => b.score - a.score || a.depth - b.depth);

		if(
			candidates.length > 1 &&
			candidates[0].score === candidates[1].score &&
			candidates[0].value !== candidates[1].value
		){
			debug('Ambiguous MEE6 setting response; ignoring value', setting.id, candidates);
			return null;
		}

		return candidates[0].value;
	}

	function consumeObservedPageSettings(data, url){
		if(!STATE.page || !currentPageAllowsRequest(url)){
			return;
		}

		for(const setting of currentSettings()){
			const value = findSettingValueInResponse(data, setting);

			if(value !== null){
				setServerSettingValue(setting, value, 'mee6-api');
			}
		}
	}

	function observeMee6Response(data, url){
		if(!configuredPageAllowsRequest(url)){
			return;
		}

		STATE.apiSnapshots.push({
			url: String(url),
			data
		});

		if(STATE.apiSnapshots.length > 32){
			STATE.apiSnapshots.splice(0, STATE.apiSnapshots.length - 32);
		}

		consumeObservedPageSettings(data, url);
	}

	function replayObservedPageSettings(){
		if(!STATE.page){
			return;
		}

		for(const snapshot of STATE.apiSnapshots){
			if(currentPageAllowsRequest(snapshot.url)){
				consumeObservedPageSettings(snapshot.data, snapshot.url);
			}
		}
	}

	/**********************************************************************
	 * Setting limits and validation
	 **********************************************************************/

	function getEffectiveMax(setting){
		let max = Number(setting.max);

		if(typeof setting.getEffectiveMax === 'function'){
			const dynamicMax = setting.getEffectiveMax({
				page: STATE.page,
				guild: STATE.guild
			});

			if(dynamicMax !== null && dynamicMax !== undefined){
				const parsed = Number(dynamicMax);

				if(Number.isFinite(parsed)){
					max = Math.min(max, parsed);
				}
			}
		}

		return max;
	}

	function getSafeValidationMax(setting){
		if(STATE.guild.status === 'loading' || STATE.guild.capabilities.voiceBitrateMax === null){
			return Math.min(Number(setting.max), 96);
		}

		return getEffectiveMax(setting);
	}

	function validateSettingValue(setting, value, {forRequest = false} = {}){
		const number = Number(value);

		if(!Number.isFinite(number)){
			return {
				valid: false,
				reason: 'not-finite'
			};
		}

		if(setting.type === 'integer-range' && !Number.isInteger(number)){
			return {
				valid: false,
				reason: 'not-integer'
			};
		}

		const min = Number(setting.min);
		const max = forRequest ? getSafeValidationMax(setting) : getEffectiveMax(setting);

		if(number < min){
			return {
				valid: false,
				reason: 'below-minimum',
				min
			};
		}

		if(number > max){
			return {
				valid: false,
				reason: 'above-current-capability',
				max
			};
		}

		const step = Number(setting.step || 1);

		if(setting.type === 'integer-range' && ((number - min) % step !== 0)){
			return {
				valid: false,
				reason: 'invalid-step',
				step
			};
		}

		return {
			valid: true,
			value: number
		};
	}

	function pathEquals(a, b){
		if(a.length !== b.length){
			return false;
		}

		for(let i = 0; i < a.length; ++i){
			if(a[i] !== b[i]){
				return false;
			}
		}

		return true;
	}

	function findSettingByPayloadPath(path){
		for(const setting of currentSettings()){
			for(const targetPath of setting.payloadPaths || []){
				if(pathEquals(path, targetPath)){
					return setting;
				}
			}
		}

		return null;
	}

	/**********************************************************************
	 * Outbound payload patching
	 **********************************************************************/

	function sanitizeObject(value, path = []){
		if(!value || typeof value !== 'object'){
			return {
				ok: true,
				changed: false
			};
		}

		let changed = false;

		if(Array.isArray(value)){
			for(let i = 0; i < value.length; ++i){
				const result = sanitizeObject(value[i], [...path, i]);

				if(!result.ok){
					return result;
				}

				changed ||= result.changed;
			}

			return {
				ok: true,
				changed
			};
		}

		for(const [field, original] of Object.entries(value)){
			const currentPath = [...path, field];
			const setting = findSettingByPayloadPath(currentPath);

			if(setting){
				const runtime = getSettingRuntime(setting);
				const outgoing = runtime.overrideValue !== null ? runtime.overrideValue : Number(original);
				const validation = validateSettingValue(setting, outgoing, {forRequest: true});

				if(!validation.valid){
					return {
						ok: false,
						reason: 'invalid-known-field',
						field,
						path: currentPath,
						value: outgoing,
						validation
					};
				}

				if(runtime.overrideValue !== null && Number(original) !== validation.value){
					value[field] = validation.value;
					changed = true;
				}
			}

			if(value[field] && typeof value[field] === 'object'){
				const result = sanitizeObject(value[field], currentPath);

				if(!result.ok){
					return result;
				}

				changed ||= result.changed;
			}
		}

		return {
			ok: true,
			changed
		};
	}

	function patchJsonBody(body){
		if(typeof body !== 'string'){
			return {
				ok: true,
				body
			};
		}

		let parsed;

		try{
			parsed = JSON.parse(body);
		}
		catch{
			return {
				ok: true,
				body
			};
		}

		const result = sanitizeObject(parsed);

		if(!result.ok){
			return result;
		}

		return {
			ok: true,
			body: result.changed ? JSON.stringify(parsed) : body
		};
	}

	function patchSearchParams(params){
		const copy = new URLSearchParams(params);

		for(const setting of currentSettings()){
			const runtime = getSettingRuntime(setting);

			for(const path of setting.payloadPaths || []){
				if(path.length !== 1){
					continue;
				}

				const field = path[0];

				if(!copy.has(field)){
					continue;
				}

				const original = Number(copy.get(field));
				const outgoing = runtime.overrideValue !== null ? runtime.overrideValue : original;
				const validation = validateSettingValue(setting, outgoing, {forRequest: true});

				if(!validation.valid){
					return {
						ok: false,
						reason: 'invalid-known-field',
						field,
						validation
					};
				}

				if(runtime.overrideValue !== null){
					copy.set(field, String(validation.value));
				}
			}
		}

		return {
			ok: true,
			body: copy
		};
	}

	function patchFormData(formData){
		const copy = new FormData();

		for(const [key, value] of formData.entries()){
			copy.append(key, value);
		}

		for(const setting of currentSettings()){
			const runtime = getSettingRuntime(setting);

			for(const path of setting.payloadPaths || []){
				if(path.length !== 1){
					continue;
				}

				const field = path[0];

				if(!copy.has(field)){
					continue;
				}

				const existing = copy.get(field);

				if(typeof existing !== 'string'){
					continue;
				}

				const original = Number(existing);
				const outgoing = runtime.overrideValue !== null ? runtime.overrideValue : original;
				const validation = validateSettingValue(setting, outgoing, {forRequest: true});

				if(!validation.valid){
					return {
						ok: false,
						reason: 'invalid-known-field',
						field,
						validation
					};
				}

				if(runtime.overrideValue !== null){
					copy.set(field, String(validation.value));
				}
			}
		}

		return {
			ok: true,
			body: copy
		};
	}

	function patchRequestBody(body){
		if(typeof body === 'string'){
			return patchJsonBody(body);
		}

		if(body instanceof URLSearchParams){
			return patchSearchParams(body);
		}

		if(body instanceof FormData){
			return patchFormData(body);
		}

		return {
			ok: true,
			body
		};
	}

	function createBlockedRequestError(details){
		const error = new Error('MEE6 Extended Settings blocked an invalid outgoing request.');

		error.name = 'MEE6ExtendedSettingsValidationError';
		error.details = details;

		return error;
	}

	/**********************************************************************
	 * Fetch / XHR interception
	 **********************************************************************/

	const nativeFetch = window.fetch.bind(window);

	window.fetch = async function(input, init = {}){
		const url = typeof input === 'string' ? input : input?.url || '';
		let newInput = input;
		const newInit = {...init};

		if(STATE.page && currentPageAllowsRequest(url)){
			if(Object.prototype.hasOwnProperty.call(newInit, 'body')){
				const result = patchRequestBody(newInit.body);

				if(!result.ok){
					throw createBlockedRequestError(result);
				}

				newInit.body = result.body;
			}
			else if(input instanceof Request){
				const contentType = input.headers.get('content-type') || '';

				if(contentType.includes('application/json')){
					const body = await input.clone().text();
					const result = patchJsonBody(body);

					if(!result.ok){
						throw createBlockedRequestError(result);
					}

					if(result.body !== body){
						newInput = new Request(input, {
							body: result.body
						});
					}
				}
			}
		}

		const response = await nativeFetch(newInput, newInit);

		void inspectFetchResponse(response, url);

		return response;
	};

	async function inspectFetchResponse(response, url){
		try{
			if(!response?.ok){
				return;
			}

			const contentType = response.headers.get('content-type') || '';

			if(!contentType.includes('application/json')){
				return;
			}

			const data = await response.clone().json();

			observeMee6Response(data, url);
		}
		catch(error){
			debug('Fetch response inspection skipped', url, error);
		}
	}

	const nativeXhrOpen = XMLHttpRequest.prototype.open;
	const nativeXhrSend = XMLHttpRequest.prototype.send;

	XMLHttpRequest.prototype.open = function(method, url){
		this.__mee6ExtendedUrl = String(url);

		return nativeXhrOpen.apply(this, arguments);
	};

	XMLHttpRequest.prototype.send = function(body){
		const url = this.__mee6ExtendedUrl || '';
		let outgoingBody = body;

		if(STATE.page && currentPageAllowsRequest(url)){
			const result = patchRequestBody(body);

			if(!result.ok){
				throw createBlockedRequestError(result);
			}

			outgoingBody = result.body;
		}

		this.addEventListener('load', () => {
			try{
				const contentType = this.getResponseHeader('content-type') || '';

				if(this.status < 200 || this.status >= 300 || !contentType.includes('application/json')){
					return;
				}

				let data = null;

				if(this.responseType === 'json'){
					data = this.response;
				}
				else if(!this.responseType || this.responseType === 'text'){
					data = JSON.parse(this.responseText);
				}

				if(data){
					observeMee6Response(data, url);
				}
			}
			catch(error){
				debug('XHR response inspection skipped', error);
			}
		}, {
			once: true
		});

		return nativeXhrSend.call(this, outgoingBody);
	};

	/**********************************************************************
	 * DOM discovery
	 **********************************************************************/

	function normalizeText(text){
		return String(text || '')
			.replace(/\s+/g, ' ')
			.trim()
			.toLowerCase();
	}

	function findSettingLabel(setting){
		const expected = normalizeText(setting.label);

		return [...document.querySelectorAll('label')]
			.find(label => normalizeText(label.textContent) === expected) || null;
	}

	function findOriginalControl(label){
		let candidate = label.nextElementSibling;

		for(let i = 0; candidate && i < 6; ++i){
			if(
				candidate.querySelector('input[type="range"]') ||
				candidate.querySelector('[class*="cursor-pointer"]')
			){
				return candidate;
			}

			candidate = candidate.nextElementSibling;
		}

		return null;
	}

	/**********************************************************************
	 * Integer-range UI
	 **********************************************************************/

	function createIntegerRangeControl(setting, originalControl){
		const root = document.createElement('div');
		const sliderWrap = document.createElement('div');
		const blockedRegion = document.createElement('div');
		const limitMarker = document.createElement('div');
		const limitLabel = document.createElement('div');
		const slider = document.createElement('input');
		const controls = document.createElement('div');
		const number = document.createElement('input');
		const unit = document.createElement('span');
		const refreshButton = document.createElement('button');
		const info = document.createElement('div');

		root.dataset.mee6ExtendedSetting = setting.id;
		root.style.maxWidth = '491px';
		root.style.marginTop = '16px';
		root.style.marginBottom = '8px';

		sliderWrap.style.position = 'relative';
		sliderWrap.style.paddingTop = '20px';

		blockedRegion.style.position = 'absolute';
		blockedRegion.style.top = '27px';
		blockedRegion.style.right = '0';
		blockedRegion.style.height = '6px';
		blockedRegion.style.background = 'rgba(0, 0, 0, 0.35)';
		blockedRegion.style.borderRadius = '9999px';
		blockedRegion.style.pointerEvents = 'none';
		blockedRegion.style.zIndex = '2';

		limitMarker.style.position = 'absolute';
		limitMarker.style.top = '20px';
		limitMarker.style.width = '2px';
		limitMarker.style.height = '20px';
		limitMarker.style.background = '#f0b232';
		limitMarker.style.pointerEvents = 'none';
		limitMarker.style.zIndex = '4';

		limitLabel.style.position = 'absolute';
		limitLabel.style.top = '0';
		limitLabel.style.transform = 'translateX(-50%)';
		limitLabel.style.fontSize = '10px';
		limitLabel.style.color = '#b9bbbe';
		limitLabel.style.whiteSpace = 'nowrap';

		slider.type = 'range';
		slider.className = 'mee6-extended-range';
		slider.min = String(setting.min);
		slider.max = String(setting.max);
		slider.step = String(setting.step || 1);

		controls.style.display = 'flex';
		controls.style.alignItems = 'center';
		controls.style.gap = '10px';
		controls.style.marginTop = '8px';
		controls.style.flexWrap = 'wrap';

		number.type = 'number';
		number.className = 'mee6-extended-number';
		number.min = String(setting.min);
		number.max = String(setting.max);
		number.step = String(setting.step || 1);
		number.style.width = '90px';
		number.style.padding = '7px 9px';
		number.style.borderRadius = '6px';
		number.style.border = '1px solid #3f4147';
		number.style.background = '#18191f';
		number.style.color = '#ffffff';

		unit.textContent = setting.unit || '';
		unit.style.color = '#b9bbbe';

		refreshButton.type = 'button';
		refreshButton.className = 'mee6-extended-refresh';
		refreshButton.textContent = 'Refresh Discord data';
		refreshButton.style.padding = '6px 10px';
		refreshButton.style.border = '1px solid #3f4147';
		refreshButton.style.borderRadius = '6px';
		refreshButton.style.background = 'rgba(255,255,255,0.08)';
		refreshButton.style.color = '#ffffff';
		refreshButton.style.cursor = 'pointer';

		info.style.marginTop = '7px';
		info.style.fontSize = '12px';
		info.style.color = '#8e9297';

		function clamp(value){
			value = Number(value);

			const min = Number(setting.min);
			const max = getEffectiveMax(setting);

			if(!Number.isFinite(value)){
				return min;
			}

			return Math.min(max, Math.max(min, Math.round(value)));
		}

		function formatAge(timestamp){
			if(!timestamp){
				return null;
			}

			const age = Math.max(0, Date.now() - timestamp);

			if(age < 60000){
				return 'just now';
			}

			if(age < 60 * 60000){
				return `${Math.floor(age / 60000)}m ago`;
			}

			if(age < 24 * 60 * 60000){
				return `${Math.floor(age / (60 * 60000))}h ago`;
			}

			return `${Math.floor(age / (24 * 60 * 60000))}d ago`;
		}

		function refresh(){
			const runtime = getSettingRuntime(setting);
			const guildPending = STATE.guild.status === 'loading' || STATE.guild.capabilities.voiceBitrateMax === null;
			const settingPending = !runtime.resolved;
			const pending = guildPending || settingPending;
			const effectiveMax = guildPending ? Number(setting.max) : getEffectiveMax(setting);
			const displayedValue = getDisplayedSettingValue(setting);

			slider.disabled = pending;
			number.disabled = pending;
			refreshButton.disabled = guildPending;

			number.max = String(effectiveMax);

			if(displayedValue !== null){
				const valuePercent = ((displayedValue - setting.min) / (setting.max - setting.min)) * 100;

				slider.value = String(displayedValue);
				number.value = String(displayedValue);
				slider.style.setProperty('--mee6-value-percent', `${valuePercent}%`);
			}
			else{
				slider.value = String(setting.min);
				number.value = '';
				slider.style.setProperty('--mee6-value-percent', '0%');
			}

			if(guildPending){
				limitMarker.style.display = 'none';
				limitLabel.style.display = 'none';
				blockedRegion.style.display = 'none';
			}
			else{
				const limitPercent = ((effectiveMax - setting.min) / (setting.max - setting.min)) * 100;
				const limited = effectiveMax < setting.max;

				limitMarker.style.left = `calc(${limitPercent}% - 1px)`;
				limitLabel.style.left = `${limitPercent}%`;
				limitLabel.textContent = String(effectiveMax);
				blockedRegion.style.left = `${limitPercent}%`;

				limitMarker.style.display = limited && setting.showLimitMarker ? 'block' : 'none';
				limitLabel.style.display = limited && setting.showLimitMarker ? 'block' : 'none';
				blockedRegion.style.display = limited && setting.showBlockedRegion ? 'block' : 'none';
			}

			if(settingPending){
				info.textContent = 'Loading MEE6 setting data...';
			}
			else if(guildPending){
				info.textContent = 'Loading Discord server capabilities...';
			}
			else if(STATE.guild.tier !== null){
				const age = formatAge(STATE.guild.fetchedAt);

				let text = `Discord Boost Level ${STATE.guild.tier} • Maximum ${effectiveMax} ${setting.unit}`;

				if(STATE.guild.boosts !== null){
					text += ` • ${STATE.guild.boosts} boosts`;
				}

				if(age){
					text += ` • Updated ${age}`;
				}

				info.textContent = text;
			}
			else{
				info.textContent = `Guild capability unavailable • Safe limit ${effectiveMax} ${setting.unit}`;
			}
		}

		slider.addEventListener('input', () => {
			if(slider.disabled){
				return;
			}

			const value = clamp(slider.value);
			const validation = validateSettingValue(setting, value);

			if(!validation.valid){
				refresh();
				return;
			}

			setUserOverride(setting, validation.value);
		});

		number.addEventListener('change', () => {
			if(number.disabled){
				return;
			}

			const validation = validateSettingValue(setting, number.value);

			if(!validation.valid){
				warn('Rejected unsupported setting value', number.value, validation);
				refresh();
				return;
			}

			setUserOverride(setting, validation.value);
		});

		refreshButton.addEventListener('click', async() => {
			resetGuildCapability('loading');
			refresh();

			await resolveGuildCapability({
				force: true
			});

			refresh();
		});

		controls.append(number, unit, refreshButton);
		sliderWrap.append(blockedRegion, limitMarker, limitLabel, slider);
		root.append(sliderWrap, controls, info);

		root.__mee6Refresh = refresh;

		refresh();

		return root;
	}

	const CONTROL_TYPES = {
		'integer-range': createIntegerRangeControl
	};

	/**********************************************************************
	 * Control installation / SPA
	 **********************************************************************/

	function installSetting(setting){
		const selector = `[data-mee6-extended-setting="${CSS.escape(setting.id)}"]`;
		const existing = document.querySelector(selector);

		if(existing){
			existing.__mee6Refresh?.();
			return;
		}

		const label = findSettingLabel(setting);

		if(!label){
			return;
		}

		const original = findOriginalControl(label);

		if(!original){
			return;
		}

		const factory = CONTROL_TYPES[setting.type];

		if(!factory){
			warn('Unsupported control type', setting.type, setting.id);
			return;
		}

		const replacement = factory(setting, original);

		if(!replacement){
			return;
		}

		original.style.display = 'none';
		original.insertAdjacentElement('afterend', replacement);

		debug('Installed setting', setting.id);
	}

	function installControls(){
		if(!STATE.page){
			return;
		}

		for(const setting of currentSettings()){
			installSetting(setting);
		}
	}

	function refreshControls(){
		for(const setting of currentSettings()){
			document
				.querySelector(`[data-mee6-extended-setting="${CSS.escape(setting.id)}"]`)
				?.__mee6Refresh?.();
		}
	}

	let knownPath = location.pathname;
	let updateScheduled = false;

	function installRouteHooks(){
		for(const method of ['pushState', 'replaceState']){
			const original = history[method];

			history[method] = function(...args){
				const result = original.apply(this, args);

				scheduleUpdate();

				return result;
			};
		}

		window.addEventListener('popstate', scheduleUpdate);
	}

	function scheduleUpdate(){
		if(updateScheduled){
			return;
		}

		updateScheduled = true;

		requestAnimationFrame(() => {
			updateScheduled = false;

			if(location.pathname !== knownPath){
				knownPath = location.pathname;
				updatePage();
			}

			installControls();
			refreshControls();
		});
	}

	function start(){
		installStyles();
		installRouteHooks();
		updatePage();
		installControls();

		const observer = new MutationObserver(scheduleUpdate);

		observer.observe(document.documentElement, {
			childList: true,
			subtree: true,
			characterData: true
		});
	}

	if(document.readyState === 'loading'){
		document.addEventListener('DOMContentLoaded', start, {
			once: true
		});
	}
	else{
		start();
	}

	updatePage();

	debug('MEE6 Extended Settings loaded');
})();
