(function() {

	"use strict";

	const MANIFEST = chrome.runtime.getManifest();
	const DEV_MODE = !('update_url' in MANIFEST);
	const VERSION = MANIFEST.version;
	const LOG_PREFIX = '[Derpi-PostVotes] ';
	const PROCESSED_CLASS_NAME = 'dpv-processed';
	const INSERTED_CLASS_NAME = 'dpv-inserted';
	const DISABLED_CLASS_NAME = 'dpv-disabled';
	const INTERACTION_CONTAINER_CLASS_NAME = 'dpv-interaction-container';
	const API_KEY_SESSION_CACHE_KEY = 'apikey';

	const prepend = (parent, el) => parent.insertBefore(el, parent.firstChild);
	const findInteractionsContainer = comm => comm.querySelector('.communication__options').children[0].children[1];

	class ExtensionStorage {
		getItem(key) {
			return new Promise(res => {
				chrome.storage.local.get(key, items => res(items[key]));
			});
		}

		setItem(key, value) {
			return new Promise(res => {
				chrome.storage.local.set({ [key]: value }, () => res());
			});
		}

		removeItem(key) {
			return new Promise(res => {
				chrome.storage.local.remove(key, () => res());
			});
		}
	}

	const extensionStorage = new ExtensionStorage();

	class StyleInjector {
		constructor() {
			this._element = document.createElement('style');
			document.head.appendChild(this._element);
		}

		setContent(cssString) {
			this._element.innerHTML = cssString;
		}
	}

	const customCSS = new StyleInjector();

	class Wrapper {
		constructor() {
			this.scoreDisplays = {};
			this.interactionEls = { up: {}, down: {} };
			this.client = null;
			this.user = null;
			this.hookTimer = null;
			this.limitTimer = null;
			customCSS.setContent(`
				.${DISABLED_CLASS_NAME} { opacity: .5; pointer-events: none }
				.${INTERACTION_CONTAINER_CLASS_NAME} { display: flex; align-items: center; user-select: none; cursor: default }
				.${INSERTED_CLASS_NAME}.communication__interaction { padding: 1px 2px; display: inline-block }
			`);
		}

		init() {
			this.fetchApiKey().then(apiKey => {
				let connstr = 'https://dv.seinopsys.hu:2096/';
				// Allow overriding connection string from localStorage in development
				if (DEV_MODE){
					connstr = localStorage.getItem('connstr') || connstr;
				}

				this.client = io(connstr, { reconnectionDelay: 10000 });
				this.client.on('connect', () => {
					console.info(`${LOG_PREFIX}%cExtension v%s: Connected to voting server`, 'color:green', VERSION);

					this.client.emit('auth', { apiKey });
				});
				this.client.on('disconnect', () => {
					console.info(`${LOG_PREFIX}%cDisconnected`, 'color:red');

					this.destroyElements();
				});
				this.client.on('auth', data => {
					if (!data.status){
						console.info(`${LOG_PREFIX}%cAuthentication failed`, 'color:red');
						this.client.disconnect();
						return;
					}

					this.userId = data.userId;
					console.info(`${LOG_PREFIX}%cServer v%s: Authenticated as user %s`, 'color:green', data.version, this.userId);
					this.pollElements();
					this.hookTimer = setInterval(() => this.pollElements(), 3000);
				});
				this.client.on('vote-cast', data => {
					Object.keys(data.scores).forEach(commId => {
						if (!this.scoreDisplays[commId])
							return;

						this.scoreDisplays[commId].innerHTML = data.scores[commId];
					});
					Object.keys(data.userVotes).forEach(commId => {
						const userVote = data.userVotes[commId];
						if (userVote.userId !== this.userId)
							return;

						['up', 'down'].forEach(direction => {
							if (!this.interactionEls[direction][commId])
								return;

							const cl = this.interactionEls[direction][commId].classList;
							if (userVote.direction === direction)
								cl.add('active');
							else cl.remove('active');
						});
					});
				});
				this.client.on('vote-limit-reached', data => {
					console.info(`${LOG_PREFIX}%cVote rate limit reached, votes cannot be cast by user %d for the next %d seconds`, 'color:#a55', this.userId, data.allowVotingIn);
					extensionStorage.setItem(this.getLimitKey(), new Date().getTime() + (data.allowVotingIn * 1000));
					this.setLimitTimer();
				});
				this.client.on('rate-limit', data => {
					alert(`This action is limited to ${data.threshold} per ${data.ttl} seconds. Please wait a bit and try again.`);
				});
			}).catch(err => {
				console.error(err);
				console.info(`${LOG_PREFIX}%cMust be logged in to vote`, 'color:blue');
			});
		}

		fetchApiKey() {
			const signedIn = document.querySelector('.js-datastore').dataset.userIsSignedIn === 'true';
			if (!signedIn){
				extensionStorage.removeItem(API_KEY_SESSION_CACHE_KEY);
				return Promise.reject('Not logged in');
			}

			return extensionStorage.getItem(API_KEY_SESSION_CACHE_KEY).then(sessionSavedValue => {
				if (sessionSavedValue)
					return Promise.resolve(sessionSavedValue);

				return fetch('/users/edit')
					.then(r => r.text())
					.then(r => {
						const match = r.match(/<h3>API Key<\/h3><p>Your API key is <strong>([A-Za-z\d-]+)<\/strong>/);
						if (!match)
							return Promise.reject('API key missing');

						extensionStorage.setItem(API_KEY_SESSION_CACHE_KEY, match[1]);
						return Promise.resolve(match[1]);
					})
			});
		}

		pollElements() {
			const comms = document.querySelectorAll(`.block.communication:not(.${PROCESSED_CLASS_NAME})`);
			if (comms.length === 0)
				return;

			console.info(`${LOG_PREFIX}Found %d new elements to hook into`, comms.length);

			const commsArray = [];
			const entities = {};
			Array.from(comms).forEach(comm => {
				comm.classList.add(PROCESSED_CLASS_NAME);
				if (!/^(comment|post)_\d+$/.test(comm.id))
					return;

				const [type, id] = comm.id.split('_');
				if (entities[type] === undefined)
					entities[type] = [];
				entities[type].push(id);
				commsArray.push(comm);
			});
			this.client.emit('get-scores', { entities }, data => {
				commsArray.forEach(comm => {
					const interactionsContainer = findInteractionsContainer(comm);
					interactionsContainer.classList.add(INTERACTION_CONTAINER_CLASS_NAME);
					const score = data.scores[comm.id] || 0;
					const userVote = data.userVotes[comm.id];

					prepend(interactionsContainer, this.createInteractionElement('&bull;'));
					prepend(interactionsContainer, this.createLink('Down', 'arrow-down', comm.id, userVote));
					prepend(interactionsContainer, this.createScoreDisplay(score, comm.id, userVote));
					prepend(interactionsContainer, this.createLink('Up', 'arrow-up', comm.id, userVote));
				});
				this.setLimitTimer();
			});
		}

		forEachElement(f) {
			const comms = document.querySelectorAll(`.block.communication.${PROCESSED_CLASS_NAME}`);
			if (comms.length === 0)
				return;

			Array.from(comms).forEach(f);
		}

		enableElements() {
			this.forEachElement(comm => {
				[
					this.interactionEls.up[comm.id],
					this.interactionEls.down[comm.id]
				].forEach(el => {
					if (el) el.classList.remove(DISABLED_CLASS_NAME);
				});
				const interactionsContainer = findInteractionsContainer(comm);
				if (interactionsContainer)
					interactionsContainer.title = undefined;
			});
		}

		disableElements(date) {
			this.forEachElement(comm => {
				[
					this.interactionEls.up[comm.id],
					this.interactionEls.down[comm.id]
				].forEach(el => {
					if (el) el.classList.add(DISABLED_CLASS_NAME);
				});
				const interactionsContainer = findInteractionsContainer(comm);
				if (interactionsContainer)
					interactionsContainer.title = `You cast too many votes in a short period of time. Please wait until ${date.toLocaleTimeString()} before trying again.`;
			});
		}

		destroyElements() {
			this.forEachElement(comm => {
				delete this.scoreDisplays[comm.id];
				delete this.interactionEls.up[comm.id];
				delete this.interactionEls.down[comm.id];

				const interactionsContainer = findInteractionsContainer(comm);
				if (interactionsContainer)
					interactionsContainer.classList.remove(INTERACTION_CONTAINER_CLASS_NAME);

				let inserted = interactionsContainer.querySelectorAll(`.${INSERTED_CLASS_NAME}`);
				Array.from(inserted).forEach(el => el.parentNode.removeChild(el));

				clearInterval(this.hookTimer);
				this.hookTimer = null;
				clearInterval(this.limitTimer);
				this.limitTimer = null;

				comm.classList.remove(PROCESSED_CLASS_NAME);
			});
		}

		createLink(direction, icon, commId, userVote) {
			const [type, id] = commId.split('_');
			const lcDirection = direction.toLowerCase();
			const lcDirectionLabel = lcDirection + 'vote';
			const el = document.createElement('a');
			el.className = `${INSERTED_CLASS_NAME} communication__interaction interaction--${lcDirectionLabel}`;
			if (userVote === lcDirection)
				el.className += ' active';
			el.href = `#${lcDirectionLabel}`;
			el.title = direction + 'vote';
			el.innerHTML = `<i class="fa fa-${icon}"></i>`;
			el.addEventListener('click', e => {
				e.preventDefault();
				e.stopPropagation();

				if (el.classList.contains('disabled'))
					return;

				const direction = el.classList.contains('active') ? null : lcDirection;
				this.client.emit('vote', { type, id, direction })
			});
			this.interactionEls[lcDirection][commId] = el;
			return el;
		}

		createScoreDisplay(score, commId) {
			if (this.scoreDisplays[commId])
				return;

			const el = this.createInteractionElement(score, 'strong');
			this.scoreDisplays[commId] = el;
			return el;
		}

		createInteractionElement(html, tag = 'span') {
			const el = document.createElement(tag);
			el.className = `${INSERTED_CLASS_NAME} communication__interaction`;
			el.innerHTML = html;
			return el;
		}

		getLimitKey() {
			return `${this.userId}_limited_until`;
		}

		isLimited() {
			return extensionStorage.getItem(this.getLimitKey()).then(untilTs => {
				if (!untilTs)
					return Promise.resolve(false);

				const nowTs = new Date().getTime();
				if (nowTs > untilTs)
					return Promise.resolve(false);

				return Promise.resolve({ untilTs, diff: untilTs - nowTs });
			});
		}

		setLimitTimer() {
			this.isLimited().then(data => {
				if (data === false)
					return;

				if (this.limitTimer)
					clearTimeout(this.limitTimer);
				this.limitTimer = setTimeout(() => {
					console.info(`${LOG_PREFIX}%cVoting rate limit refreshed for user %d`, 'color:deepskyblue', this.userId);
					this.enableElements();
					this.limitTimer = null;
				}, data.diff);
				console.info(`${LOG_PREFIX}%cVoting rate limit for user %d will refresh in %f second(s)`, 'color:deepskyblue', this.userId, data.diff / 1000);
				this.disableElements(new Date(data.untilTs));
			});
		}
	}

	const wrapper = new Wrapper();
	wrapper.init();
})();
