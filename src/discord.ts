import {
	Client,
	GatewayIntentBits,
	REST,
	Routes,
	Message
} from 'discord.js';
import { useRedeemer } from './redeemer.js';
import { commands, handleSlashCommand } from './discord-commands.js';

const extractGiftCode = (message: string) => {
	// Global match to traverse multi-line text blocks reliably
	const matches = message.match(/`\s*([a-zA-Z0-9]{5,20})\s*`/g);
	if (matches && matches.length > 0) {
		// Take the first code found in the message and strip backticks
		return matches[0].replace(/`/g, '').trim();
	}

	return undefined;
};

const handleMessageCreate = async (message: Message) => {
	const { author, content, channel, client } = message;

	// 🛑 Ignore ONLY its own messages
	if (author.id === client.user?.id) return;

	if (!channel.isSendable()) {
		throw new Error('Cannot send a message through this channel. 😳');
	}

	const { id, globalName } = author;

	console.log(`💬 Message from ${globalName} (${id}): ${content}`);

	const giftCode = extractGiftCode(content);
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

		// 4-second delay before allowing the handler to finish
		await new Promise(r => setTimeout(r, 4000));
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

	client.once(
		'clientReady',
		() => {
			const { user } = client;

			if (user) {
				console.log(`🤖 Discord bot logged in as ${user?.tag}!`);
			} else {
				console.log('🤖 Discord bot logged in.');
			}
		}
	);

	client.on(
		'interactionCreate',
		async (interaction) => {
			if (interaction.isChatInputCommand()) {
				await handleSlashCommand(interaction);
			}
		}
	);

	client.on('messageCreate', handleMessageCreate);

	await registerCommands(TOKEN);
	await client.login(TOKEN);

	return client;
};
