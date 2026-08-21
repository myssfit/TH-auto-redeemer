import { Client, GatewayIntentBits } from 'discord.js';
import { handleSlashCommand } from './discord-commands.js';
import { useRedeemer } from './redeemer.js';

export const setupDiscordBot = () => {
	const client = new Client({
		intents: [
			GatewayIntentBits.Guilds,
			GatewayIntentBits.GuildMessages,
			GatewayIntentBits.MessageContent
		]
	});

	client.on('ready', () => {
		console.log(`🤖 Logged in as ${client.user?.tag}!`);
	});

	client.on('interactionCreate', async (interaction) => {
		if (!interaction.isChatInputCommand()) return;
		await handleSlashCommand(interaction);
	});

	// Handle auto-detection on incoming channel messages
	client.on('messageCreate', async (message) => {
		// Ignore bot messages (including itself) to avoid infinite loops
		if (message.author.bot) return;

		const content = message.content;
		if (!content) return;

		// Clean up markdown
		const cleanText = content.replace(/[`*~_]/g, ' ').trim();
		const words = cleanText.split(/\s+/);

		const stopWords = new Set([
			'http', 'https', 'discord', 'topheroes', 'store', 'channel', 'valid', 
			'until', 'event', 'added', 'removed', 'found', 'check', 'cleared', 'users', 'user'
		]);

		const potentialCodes: string[] = [];

		for (const word of words) {
			const clean = word.replace(/^[^\w]+|[^\w]+$/g, '');
			if (
				clean.length >= 5 &&
				clean.length <= 20 &&
				!stopWords.has(clean.toLowerCase()) &&
				/^[a-zA-Z0-9]+$/.test(clean)
			) {
				potentialCodes.push(clean);
			}
		}

		if (potentialCodes.length === 0) return;

		const { redeemForAll } = useRedeemer();
		for (const code of potentialCodes) {
			console.log(`🎁 Auto-detected gift code: ${code}`);
			await redeemForAll(code);
			// 3 second delay between code attempts to prevent 429
			await new Promise(r => setTimeout(r, 3000));
		}
	});

	client.login(process.env.DISCORD_TOKEN);
};
