import { Client, GatewayIntentBits } from 'discord.js';
import { handleSlashCommand, extractGiftCodesFromText } from './discord-commands.js';
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
		// 🛑 Ignore ONLY itself (allows scraper/web bots to trigger codes)
		if (message.author.id === client.user?.id) return;

		const content = message.content;
		if (!content) return;

		// Extract codes strictly wrapped in backticks (e.g. `Th1rt1n`)
		const potentialCodes = extractGiftCodesFromText(content);

		if (potentialCodes.length === 0) return;

		const { redeemForAll } = useRedeemer();
		for (const code of potentialCodes) {
			console.log(`🎁 Auto-detected gift code from ${message.author.username}: ${code}`);
			await redeemForAll(code);
			// 4 second delay between codes to protect against 429 rate-limits
			await new Promise(r => setTimeout(r, 4000));
		}
	});

	client.login(process.env.DISCORD_TOKEN);
};
