(function() {

	"use strict";

	const DEV_MODE = !('update_url' in chrome.runtime.getManifest());
	const LOG_PREFIX = '[Derpi-PostVotes] ';
	const PROCESSED_CLASS_NAME = 'dpv-processed';
	const INSERTED_CLASS_NAME = 'dpv-inserted';
	const API_KEY_SESSION_CACHE_KEY = 'apikey';

	const prepend = (parent, el) => parent.insertBefore(el, parent.firstChild);
	const findInteractionsContainer = comm => comm.querySelector('.communication__options').children[0].children[1];

	class Wrapper {
		constructor() {
			this.scoreDisplays = {};
			this.interactionEls = { up: {}, down: {} };
			this.client = null;
			this.user = null;
			this.hookTimer = null;
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
					console.info(`${LOG_PREFIX}%cConnected to voting server`, 'color:green');

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

					this.user = data.user;
					console.info(`${LOG_PREFIX}%cServer v%s: Authenticated as %s`, 'color:green', data.version, this.user.name);
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
						if (userVote.userId !== this.user.id)
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
			}).catch(err => {
				console.error(err);
				console.info(`${LOG_PREFIX}%cMust be logged in to vote`, 'color:blue');
			});
		}

		fetchApiKey() {
			const signedIn = document.querySelector('.js-datastore').dataset.userIsSignedIn === 'true';
			if (!signedIn){
				sessionStorage.removeItem(API_KEY_SESSION_CACHE_KEY);
				return Promise.reject('Not logged in');
			}

			const sessionSavedValue = sessionStorage.getItem(API_KEY_SESSION_CACHE_KEY);
			if (sessionSavedValue)
				return Promise.resolve(sessionSavedValue);

			return fetch('/users/edit')
				.then(r => r.text())
				.then(r => {
					const match = r.match(/<h3>API Key<\/h3><p>Your API key is <strong>([A-Za-z\d-]+)<\/strong>/);
					if (!match)
						return Promise.reject('API key missing');

					sessionStorage.setItem(API_KEY_SESSION_CACHE_KEY, match[1]);
					return Promise.resolve(match[1]);
				})
		}

		pollElements() {
			const comms = document.querySelectorAll(`.block.communication:not(.${PROCESSED_CLASS_NAME})`);
			if (comms.length === 0)
				return;

			console.info(`${LOG_PREFIX}Found %d new elements to hook into`, comms.length);

			const commsArray = Array.from(comms);
			const entities = {};
			commsArray.forEach(comm => {
				comm.classList.add(PROCESSED_CLASS_NAME);
				const [type, id] = comm.id.split('_');
				if (entities[type] === undefined)
					entities[type] = [];
				entities[type].push(id);
			});
			this.client.emit('get-scores', { entities }, data => {
				commsArray.forEach(comm => {
					const interactionsContainer = findInteractionsContainer(comm);
					interactionsContainer.style.display = 'flex';
					interactionsContainer.style.alignItems = 'center';
					const score = data.scores[comm.id] || 0;
					const userVote = data.userVotes[comm.id];

					prepend(interactionsContainer, this.createInteractionElement('&bull;'));
					prepend(interactionsContainer, this.createLink('Down', 'arrow-down', comm.id, userVote));
					prepend(interactionsContainer, this.createScoreDisplay(score, comm.id, userVote));
					prepend(interactionsContainer, this.createLink('Up', 'arrow-up', comm.id, userVote));
				});
			});
		}

		destroyElements() {
			const comms = document.querySelectorAll(`.block.communication.${PROCESSED_CLASS_NAME}`);
			if (comms.length === 0)
				return;

			Array.from(comms).forEach(comm => {
				delete this.scoreDisplays[comm.id];
				delete this.interactionEls.up[comm.id];
				delete this.interactionEls.down[comm.id];

				let inserted = comm.querySelectorAll(`.${INSERTED_CLASS_NAME}`);
				Array.from(inserted).forEach(el => el.parentNode.removeChild(el));

				clearInterval(this.hookTimer);
				this.hookTimer = null;

				comm.classList.remove(PROCESSED_CLASS_NAME);
			});
		}

		createLink(direction, icon, commId, userVote) {
			const [type, id] = commId.split('_');
			const lcDirection = direction.toLowerCase();
			const lcDirectionLabel = lcDirection + 'vote';
			const el = document.createElement('a');
			el.className = `${INSERTED_CLASS_NAME} communication__interaction interaction--${lcDirectionLabel}`;
			el.style.display = 'inline-block';
			el.style.padding = '1px 2px';
			if (userVote === lcDirection)
				el.className += ' active';
			el.href = `#${lcDirectionLabel}`;
			el.title = direction + 'vote';
			el.innerHTML = `<i class="fa fa-${icon}"></i>`;
			el.addEventListener('click', e => {
				e.preventDefault();
				e.stopPropagation();

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
			el.title = 'Score';
			this.scoreDisplays[commId] = el;
			return el;
		}

		createInteractionElement(html, tag = 'span') {
			const el = document.createElement(tag);
			el.className = `${INSERTED_CLASS_NAME} communication__interaction`;
			el.innerHTML = html;
			return el;
		}
	}

	const wrapper = new Wrapper();
	wrapper.init();
})();
