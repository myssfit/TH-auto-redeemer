import { Client, GatewayIntentBits, REST, Routes, Message } from 'discord.js';
import { useRedeemer } from './redeemer.js';
import { commands, handleSlashCommand } from './discord-commands.js';

const extractGiftCode = (message: string): string | undefined => {
	if (!message) return undefined;

	// Clean backticks, bold markers, and standard Discord markdown formatting
	const cleanMessage = message.replace(/[`*~_]/g, ' ').trim();

	// 1. Look for explicit code labels (e.g. "Gift Code 12", "Gift Code: XYZ", "Code: XYZ", "🎁 XYZ")
	const labeledPattern = /(?:gift\s*code(?:\s*\d+)?|code|cd|🎁)[\s:#=-]*([a-zA-Z0-9]{5,20})\b/i;
	const labeledMatch = labeledPattern.exec(cleanMessage);
	if (labeledMatch) {
		return labeledMatch[1];
	}

	// 2. Fallback: Search individual clean words for alphanumeric codes (5-20 chars)
	const words = cleanMessage.split(/\s+/);
	for (const word of words) {
		const clean = word.replace(/^[^\w]+|[^\w]+$/g, '');
		
		if (
			clean.length >= 5 &&
			clean.length <= 20 &&
			!clean.startsWith('http') &&
			!['discord', 'https', 'http', 'topheroes', 'store', 'channel', 'valid', 'until', 'event'].includes(clean.toLowerCase()) &&
			/^[a-zA-Z0-9]+$/.test(clean)
		) {
			return clean;
		}
	}

	return undefined;
};

const handleMessageCreate = async ({ author, content, channel, embeds }: Message) => {
	if (!channel.isSendable()) {
		return;
	}

	const { id, globalName } = author;
	
	// Combine message content + embed descriptions (for webhooks that post formatted cards)
	let fullText = content || '';
	if (embeds && embeds.length > 0) {
		for (const embed of embeds) {
			if (embed.title) fullText += `\n${embed.title}`;
			if (embed.description) fullText += `\n${embed.description}`;
			if (embed.fields) {
				for (const field of embed.fields) {
					fullText += `\n${field.name} ${field.value}`;
				}
			}
		}
	}

	console.log(`💬 Message from ${globalName ?? 'Unknown'} (${id}): ${fullText}`);

	const giftCode = extractGiftCode(fullText);
	if (giftCode) {
		console.log(`🎁 Auto-detected gift code: ${giftCode}`);
		try {
			const { redeemForAll } = useRedeemer();
			const succeeded = await redeemForAll(giftCode);
			if (succeeded.length > 0) {
				const successList = succeeded.map(id => `\`${id}\``).join(', ');
				await channel.send(`✅ Auto-redeemed code \`${giftCode}\` for: ${successList}`);
			} else {
				await channel.send(`❌ Failed to redeem code \`${giftCode}\` for any configured users`);
			}
		} catch (error) {
			console.error('Auto-redeem error:', error);
			await channel.send(`❌ Error auto-redeeming code \`${giftCode}\`: ${error}`);
		}
	}
};

const registerCommands = async (token: string) => {
	const APPLICATION_ID = process.env.APPLICATION_ID;
	if (!APPLICATION_ID) {
		throw new Error('The environment variable "APPLICATION_ID" is required for slash commands!');
	}

	const rest = new REST().setToken(token);
	try {
		console.log('🔄 Started refreshing application (/) commands...');
		await rest.put(
			Routes.applicationCommands(APPLICATION_ID),
			{ body: commands }
		);
		console.log('✅ Successfully reloaded application (/) commands');
	} catch (error) {
		console.error('❌ Error registering commands:', error);
	}
};

export const useDiscord = async () => {
	const TOKEN = process.env.TOKEN;
	if (!TOKEN) {
		throw new Error('The environment variable "TOKEN" is not found in environment variables!');
	}

	const CHANNEL_ID = process.env.CHANNEL_ID;
	if (!CHANNEL_ID) {
		throw new Error('The environment variable "CHANNEL_ID" is not found in environment variables!');
	}

	const client = new Client({
		intents: [
			GatewayIntentBits.Guilds,
			GatewayIntentBits.GuildMessages,
			GatewayIntentBits.MessageContent
		]
	});

	client.once('clientReady', () => {
		const { user } = client;
		if (user) {
			console.log(`🤖 Discord bot logged in as ${user.tag}!`);
		} else {
			console.log('🤖 Discord bot logged in.');
		}
	});

	client.on('interactionCreate', async (interaction) => {
		if (interaction.isChatInputCommand()) {
			await handleSlashCommand(interaction);
		}
	});

	client.on('messageCreate', handleMessageCreate);

	await registerCommands(TOKEN);
	await client.login(TOKEN);

	return client;
};
