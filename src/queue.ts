import { userStore } from './user-store.js';
import { useRedeemer } from './redeemer.js';
import { label } from './labels.js';

// ─── CONFIG ──────────────────────────────
const DEBOUNCE_MS      = 5 * 60 * 1000;    // wait after FIRST code, then drain regardless
const CODE_GAP_MIN_MS  = 30 * 1000;        // gap between codes for one user
const CODE_GAP_MAX_MS  = 60 * 1000;
const USER_GAP_MIN_MS  = 20 * 1000;         // gap between users
const USER_GAP_MAX_MS  = 40 * 1000;
const LOGIN_GAP_MIN_MS = 1000;             // gap between login and first redeem
const LOGIN_GAP_MAX_MS = 9000;
const COOLDOWN_MIN_MS  = 11 * 60 * 1000;   // brake after a rate-limit signal
const COOLDOWN_MAX_MS  = 15 * 60 * 1000;
const MAX_TRANSIENT    = 3;                // attempts for network / token errors only
// ─────────────────────────────────────────

export type QueueChannel = { send: (content: string) => Promise<unknown> };

type Batch = {
	channel: QueueChannel;
	startedAt: number;
	codes: Set<string>;
	users: Set<string>;
	pending: Map<string, Set<string>>;   // userId -> codes not yet definitive
	done: Set<string>;                   // "userId:code" definitively handled
	expired: Set<string>;                // globally dead codes
	transient: Map<string, number>;      // "userId:code" -> attempts
	deferred: Set<string>;               // "userId:code" already requeued once after a brake
	tokens: Map<string, string>;         // per-batch token cache
	relogged: Set<string>;               // users already given one fresh login
};

type PassResult = {
	claimed: string[];
	already: string[];
	expired: string[];
	failed: string[];
	raw: string[];
};

let batch: Batch | undefined;
let draining = false;
let currentUser: string | undefined;
let cooldownUntil = 0;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const jitter = (min: number, max: number) => min + Math.random() * (max - min);
const key = (userId: string, code: string) => `${userId}:${code}`;
const fmt = (codes: string[]) => codes.map(c => `\`${c}\``).join(', ');

const pendingPairs = () => {
	if (!batch) return 0;
	let n = 0;
	for (const set of batch.pending.values()) n += set.size;
	return n;
};

const pickUser = (b: Batch): string | undefined => {
	const ready = [...b.pending.entries()].filter(([, set]) => set.size > 0).map(([u]) => u);
	if (ready.length === 0) return undefined;
	return ready[Math.floor(Math.random() * ready.length)];
};

const pickCode = (b: Batch, userId: string): string | undefined => {
	const set = b.pending.get(userId);
	if (!set || set.size === 0) return undefined;
	const codes = [...set];
	return codes[Math.floor(Math.random() * codes.length)];
};

const markDone = (b: Batch, userId: string, code: string) => {
	b.done.add(key(userId, code));
	b.pending.get(userId)?.delete(code);
};

const dropCodeEverywhere = (b: Batch, code: string) => {
	b.expired.add(code);
	for (const [userId, set] of b.pending) {
		if (set.delete(code)) b.done.add(key(userId, code));
	}
};

const ensureBatch = (channel: QueueChannel): Batch => {
	if (!batch) {
		batch = {
			channel,
			startedAt: Date.now(),
			codes: new Set(),
			users: new Set(),
			pending: new Map(),
			done: new Set(),
			expired: new Set(),
			transient: new Map(),
			deferred: new Set(),
			tokens: new Map(),
			relogged: new Set()
		};
		console.log(`🗂️  Batch opened — drain starts in ${DEBOUNCE_MS / 60000} min`);
		setTimeout(() => { void drain(); }, DEBOUNCE_MS);
	}
	return batch;
};

const addPair = (b: Batch, userId: string, code: string): boolean => {
	if (b.expired.has(code)) return false;
	if (b.done.has(key(userId, code))) return false;

	let set = b.pending.get(userId);
	if (!set) { set = new Set(); b.pending.set(userId, set); }
	if (set.has(code)) return false;

	set.add(code);
	b.users.add(userId);
	b.codes.add(code);
	return true;
};

export const enqueueCode = (code: string, channel: QueueChannel): number => {
	const users = userStore.list();
	if (users.length === 0) return 0;

	const b = ensureBatch(channel);
	let added = 0;
	for (const userId of users) if (addPair(b, userId, code)) added++;

	console.log(`📥 Queued ${code} for ${added} user(s) | pending pairs: ${pendingPairs()}`);
	return added;
};

export const enqueueForUser = (userId: string, codes: string[], channel: QueueChannel): number => {
	const b = ensureBatch(channel);
	let added = 0;
	for (const code of codes) if (addPair(b, userId, code)) added++;

	console.log(`📥 Queued ${added} code(s) for ${userId} | pending pairs: ${pendingPairs()}`);
	return added;
};

export const getStatus = () => {
	const b = batch;
	const users_done = b ? [...b.users].filter(u => (b.pending.get(u)?.size ?? 0) === 0).length : 0;
	const users_left = b ? [...b.users].filter(u => u !== currentUser && (b.pending.get(u)?.size ?? 0) > 0).length : 0;

	return {
		status: cooldownUntil > Date.now() ? 'cooldown' : draining ? 'draining' : b ? 'debouncing' : 'idle',
		batch_started: b ? new Date(b.startedAt).toISOString() : null,
		codes: b ? [...b.codes] : [],
		users_done,
		users_left,
		users_total: b ? b.users.size : 0,
		current_user: currentUser ?? null,
		pending_pairs: pendingPairs(),
		cooldown_until: cooldownUntil > Date.now() ? new Date(cooldownUntil).toISOString() : null
	};
};

const brake = async () => {
	const wait = jitter(COOLDOWN_MIN_MS, COOLDOWN_MAX_MS);
	cooldownUntil = Date.now() + wait;
	console.warn(`🧊 Rate limit signal — pausing drain for ${Math.round(wait / 60000)} min`);
	await sleep(wait);
	cooldownUntil = 0;
	console.log('▶️  Cooldown over — resuming drain');
};

const report = async (b: Batch, userId: string, r: PassResult) => {
	const parts: string[] = [];
	if (r.claimed.length) parts.push(`✅ ${fmt(r.claimed)} claimed`);
	if (r.already.length) parts.push(`⚠️ ${fmt(r.already)} already redeemed`);
	if (r.expired.length) parts.push(`⏰ ${fmt(r.expired)} expired`);
	if (r.failed.length) parts.push(`❌ ${fmt(r.failed)} failed`);
	if (r.raw.length) parts.push(`❓ ${r.raw.join(' · ')}`);
	if (parts.length === 0) return;

	try {
		await b.channel.send(`📊 ${label(userId)} — ${parts.join(' · ')}`);
	} catch (error) {
		console.error('❌ Could not post report:', error);
	}
};

const runUserPass = async (
	b: Batch,
	userId: string,
	login: (u: string) => Promise<any>,
	redeemWithToken: (t: string, c: string, u: string) => Promise<any>
) => {
	const r: PassResult = { claimed: [], already: [], expired: [], failed: [], raw: [] };
	let token = b.tokens.get(userId);
	let freshLogin = false;

	if (!token) {
		const result = await login(userId);

		if (result.status === 'ratelimited') { await brake(); return; }

		if (result.status !== 'ok') {
			const lk = key(userId, '__login');
			const n = (b.transient.get(lk) ?? 0) + 1;
			b.transient.set(lk, n);
			console.error(`❌ Login failed for ${userId} (attempt ${n}/${MAX_TRANSIENT})`);

			if (n >= MAX_TRANSIENT) {
				const set = b.pending.get(userId);
				if (set) {
					r.failed.push(...set);
					for (const code of [...set]) markDone(b, userId, code);
				}
				await report(b, userId, r);
			}
			return;
		}

		token = result.token;
		b.tokens.set(userId, token!);
		freshLogin = true;

		const gap = jitter(LOGIN_GAP_MIN_MS, LOGIN_GAP_MAX_MS);
		console.log(`⏱️  Login→redeem gap: ${(gap / 1000).toFixed(1)}s for ${userId}`);
		await sleep(gap);
	}

	let first = true;
	let braked = false;

	while (true) {
		const code = pickCode(b, userId);
		if (!code) break;

		if (!first || !freshLogin) {
			const gap = jitter(CODE_GAP_MIN_MS, CODE_GAP_MAX_MS);
			console.log(`⏳ Code gap: waiting ${Math.ceil(gap / 1000)}s before ${code} / ${userId}`);
			await sleep(gap);
		}
		first = false;

		const outcome = await redeemWithToken(token!, code, userId);
		const k = key(userId, code);

		if (outcome.status === 'claimed') {
			markDone(b, userId, code);
			r.claimed.push(code);
			continue;
		}

		if (outcome.status === 'already') {
			markDone(b, userId, code);
			r.already.push(code);
			continue;
		}

		if (outcome.status === 'expired') {
			dropCodeEverywhere(b, code);
			r.expired.push(code);
			console.log(`⏰ ${code} expired — dropped for all users`);
			continue;
		}

		if (outcome.status === 'ratelimited') {
			if (b.deferred.has(k)) {
				markDone(b, userId, code);
				r.failed.push(code);
				console.error(`❌ ${code} / ${userId} dropped — rate limited twice`);
			} else {
				b.deferred.add(k);
				console.warn(`🧊 ${code} / ${userId} deferred once after rate limit`);
			}
			braked = true;
			break;
		}

		// generic / unknown error
		const n = (b.transient.get(k) ?? 0) + 1;
		b.transient.set(k, n);
		r.raw.push(`\`${code}\` (${outcome.code}) ${outcome.message}`);

		if (n >= MAX_TRANSIENT) {
			markDone(b, userId, code);
			r.failed.push(code);
			continue;
		}

		if (!b.relogged.has(userId)) {
			b.relogged.add(userId);
			b.tokens.delete(userId);
			console.log(`🔁 Fresh login queued for ${userId} after error`);
			break;
		}
	}

	await report(b, userId, r);
	if (braked) await brake();
};

const drain = async () => {
	if (draining || !batch) return;
	draining = true;

	const b = batch;
	const { login, redeemWithToken } = useRedeemer();
	console.log(`🚚 Draining batch — ${b.codes.size} code(s), ${b.users.size} user(s), ${pendingPairs()} pair(s)`);

	try {
		while (true) {
			const userId = pickUser(b);
			if (!userId) break;

			currentUser = userId;
			await runUserPass(b, userId, login, redeemWithToken);
			currentUser = undefined;

			if (pickUser(b)) {
				const gap = jitter(USER_GAP_MIN_MS, USER_GAP_MAX_MS);
				console.log(`⏳ User gap: waiting ${Math.ceil(gap / 1000)}s`);
				await sleep(gap);
			}
		}
	} catch (error) {
		console.error('❌ Drain error:', error);
	} finally {
		draining = false;
		currentUser = undefined;
		batch = undefined;
		console.log('🏁 Batch complete — token cache cleared');
	}
};
