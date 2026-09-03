import axios, { type AxiosResponse, type RawAxiosRequestHeaders } from 'axios';
import { userStore } from './user-store.js';

// ─── CONFIG ──────────────────────────────
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';
const LOGIN_GAP_MIN_MS = 1000;   // min pause between login and first redeem
const LOGIN_GAP_MAX_MS = 9000;   // max pause between login and first redeem
// ─────────────────────────────────────────

const SITE_ID = 1028526 as const;
const PROJECT_ID = 1028637 as const;

const URL_TO_LOGIN: string = 'https://store.topheroes.com/api/v2/store/login/player';
const URL_TO_REDEEM: string = 'https://store.topheroes.com/api/v2/store/redemption/redeem';

// Observed API result codes
const CODE_SUCCESS = 1 as const;
const CODE_ALREADY = 80006 as const;   // Personal redemption limit reached
const CODE_EXPIRED = 80004 as const;   // Redemption code expired
const RATE_LIMIT_CODE = 10017 as const; // Frequent operations detected (HTTP 200!)

interface LoginRequestBody {
	site_id: number;
	player_id: string;
	server_id: string;
	device: string;
}

interface RedeemRequestBody {
	project_id: number;
	redemption_code: string;
}

interface LoginResponse {
	code: number;
	message: string;
	data: {
		token?: string;
		authorization?: string;
		[key: string]: any;
	} | string | null;
	timestamp?: number;
}

interface RedemptionResponse {
	code: number;
	message: string;
	data: any;
	timestamp: number;
}

export type LoginResult =
	| { status: 'ok'; token: string }
	| { status: 'ratelimited' }
	| { status: 'error'; message: string };

export type RedeemOutcome =
	| { status: 'claimed'; message: string }
	| { status: 'already' }
	| { status: 'expired' }
	| { status: 'ratelimited' }
	| { status: 'error'; code: number | string; message: string };

// A rate limit can arrive as HTTP 429 OR as HTTP 200 with code 10017 in the body
const isRateLimitError = (error: any): boolean =>
	error?.response?.status === 429 || error?.response?.data?.code === RATE_LIMIT_CODE;

export const useRedeemer = (userIds?: string[]) => {
	const targetUserIds = userIds || userStore.list();

	const loginHeaders: RawAxiosRequestHeaders = {
		'accept': 'application/json, text/plain, */*',
		'content-type': 'application/json',
		'origin': 'https://store.topheroes.com',
		'referer': 'https://store.topheroes.com/',
		'user-agent': USER_AGENT
	};

	const createAxiosInstance = () => axios.create({ headers: loginHeaders });

	const createLoginBody = (userId: string): LoginRequestBody => ({
		site_id: SITE_ID,
		player_id: userId,
		server_id: '',
		device: 'pc'
	});

	const createRedeemBody = (giftCode: string): RedeemRequestBody => ({
		project_id: PROJECT_ID,
		redemption_code: giftCode
	});

	const sleep = (duration = 666) => new Promise(resolve => setTimeout(resolve, duration));

	const loginGap = () => LOGIN_GAP_MIN_MS + Math.random() * (LOGIN_GAP_MAX_MS - LOGIN_GAP_MIN_MS);

	// ─── Step 1: log in, return a bearer token ───
	const login = async (userId: string): Promise<LoginResult> => {
		console.log(`🔐 Logging in user: ${userId}`);

		try {
			const loginResponse: AxiosResponse<LoginResponse> = await createAxiosInstance().post(
				URL_TO_LOGIN,
				createLoginBody(userId)
			);

			const loginData = loginResponse.data;
			const responseHeaders = loginResponse.headers;

			if (loginData?.code === RATE_LIMIT_CODE) {
				console.warn(`🧊 Rate limited on login for ${userId}: ${loginData.message}`);
				return { status: 'ratelimited' };
			}

			let authorization: string | undefined;

			if (typeof loginData?.data === 'object' && loginData?.data !== null) {
				authorization = loginData.data.token || loginData.data.authorization;
			} else if (typeof loginData?.data === 'string') {
				authorization = loginData.data;
			}

			if (!authorization && loginData) {
				authorization = (loginData as any).token || (loginData as any).authorization;
			}

			if (!authorization) {
				authorization = (responseHeaders['authorization'] as string | undefined) ||
					(responseHeaders['set-cookie'] ? responseHeaders['set-cookie'][0] : undefined);
			}

			if (!authorization) {
				console.error(`⚠️  The 'Authorization' token is missing for user ${userId}`);
				return { status: 'error', message: 'authorization token missing' };
			}

			return { status: 'ok', token: authorization };
		} catch (error: any) {
			if (isRateLimitError(error)) {
				console.warn(`🧊 Rate limited on login for ${userId} (HTTP ${error?.response?.status})`);
				return { status: 'ratelimited' };
			}
			console.error(`❌ Login error for user ${userId}:`, error?.message ?? error);
			return { status: 'error', message: String(error?.message ?? error) };
		}
	};

	// ─── Step 2: redeem one code with an existing token ───
	const redeemWithToken = async (token: string, giftCode: string, userId: string): Promise<RedeemOutcome> => {
		console.log(`🎯 Redeeming ${giftCode} for user: ${userId}`);

		try {
			const { data: responseData } = await createAxiosInstance().post<RedemptionResponse>(
				URL_TO_REDEEM,
				createRedeemBody(giftCode),
				{ headers: { 'Authorization': token } }
			);

			console.log('📥 Redemption API Response:', JSON.stringify(responseData));

			const { data, code, message } = responseData;

			if (code === RATE_LIMIT_CODE) return { status: 'ratelimited' };
			if (code === CODE_EXPIRED) return { status: 'expired' };
			if (code === CODE_ALREADY) return { status: 'already' };

			if (code === CODE_SUCCESS || code === 0 || code === 200 || data === 'success' || (data && typeof data === 'object')) {
				return { status: 'claimed', message: message || 'Claimed' };
			}

			return { status: 'error', code, message: message || 'unknown' };
		} catch (error: any) {
			if (isRateLimitError(error)) return { status: 'ratelimited' };
			console.error(`❌ Redeem error for user ${userId}:`, error?.message ?? error);
			return { status: 'error', code: error?.code ?? 'EXCEPTION', message: String(error?.message ?? error) };
		}
	};

	// ─── Legacy single-shot path (used by redeemForAll / manual /redeem) ───
	const redeem = async (giftCode: string, userId: string) => {
		console.log(`🎁 Attempting to redeem gift code: ${giftCode} for user:${userId}`);

		const result = await login(userId);
		if (result.status !== 'ok') return false;

		const gap = loginGap();
		console.log(`⏱️  Login→redeem gap: ${(gap / 1000).toFixed(1)}s for user ${userId}`);
		await sleep(gap);

		const outcome = await redeemWithToken(result.token, giftCode, userId);

		if (outcome.status === 'claimed') {
			console.log(`✅ Result for user ${userId}: Success (${outcome.message})`);
			return true;
		}

		console.error(`❌ Result for user ${userId}: ${outcome.status}`);
		return false;
	};

	const redeemForAll = async (giftCode: string) => {
		console.log(`🎁 Attempting to redeem gift code: ${giftCode}`);
		console.log(`👥 Target users: ${targetUserIds.join(', ')}`);

		if (targetUserIds.length === 0) {
			console.warn('⚠️  No user IDs configured. Use /add-user command to add users.');
			return [];
		}

		const succeeded: string[] = [];
		for (const [index, userId] of targetUserIds.entries()) {
			try {
				const success = await redeem(giftCode, userId);
				if (success) {
					succeeded.push(userId);
				}
			} catch (error) {
				console.error(`❌ Error processing user ${userId}:`, error);
			}

			if (index < targetUserIds.length - 1) {
				const delay = 1111 + 2222 * Math.random();
				await sleep(delay);
			}
		}

		console.log(`🏁 Finished processing gift code: ${giftCode}`);

		return succeeded;
	};

	return { login, redeemWithToken, redeem, redeemForAll };
};
