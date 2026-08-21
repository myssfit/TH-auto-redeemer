import axios, { type AxiosResponse, type RawAxiosRequestHeaders } from 'axios';
import { userStore } from './user-store.js';

const SITE_ID = 1028526 as const;
const PROJECT_ID = 1028637 as const;

const URL_TO_LOGIN: string = 'https://store.topheroes.com/api/v2/store/login/player';
const URL_TO_REDEEM: string = 'https://store.topheroes.com/api/v2/store/redemption/redeem';

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

export const useRedeemer = (userIds?: string[]) => {
	const targetUserIds = userIds || userStore.list();
	
	const loginHeaders: RawAxiosRequestHeaders = {
		'accept': 'application/json, text/plain, */*',
		'content-type': 'application/json',
		'origin': 'https://store.topheroes.com',
		'referer': 'https://store.topheroes.com/',
		'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
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

	const redeem = async (giftCode: string, userId: string) => {
		console.log(`🎁 Attempting to redeem gift code: ${giftCode} for user:${userId}`);

		const axiosInstance = createAxiosInstance();

		try {
			console.log(`🔐 Logging in user: ${userId}`);
			const loginResponse: AxiosResponse<LoginResponse> = await axiosInstance.post(
				URL_TO_LOGIN,
				createLoginBody(userId)
			);

			const loginData = loginResponse.data;
			const responseHeaders = loginResponse.headers;

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
				console.error(`⚠️  The 'Authorization' token is missing for user ${userId}, skipping`);
				return false;
			}

			console.log(`🎯 Redeeming code for user: ${userId}`);
			const { data: responseData } = await axiosInstance.post<RedemptionResponse>(
				URL_TO_REDEEM,
				createRedeemBody(giftCode),
				{
					headers: { 'Authorization': authorization }
				}
			);

			console.log('📥 Redemption API Response:', JSON.stringify(responseData));

			const { data, code, message } = responseData;

			// FIX: Top Heroes API returns code: 1 or data: 'success' / object on valid redemption
			if (code === 1 || code === 0 || code === 200 || data === 'success' || (data && typeof data === 'object')) {
				console.log(`✅ Result for user ${userId}: Success (${message || 'Claimed'})`);
				return true;
			} else {
				console.error(`❌ Error processing user ${userId}:`, `(${code})`, message);
			}
		} catch (error) {
			console.error(`❌ Error processing user ${userId}:`, error);
		}

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

	return { redeem, redeemForAll };
};
