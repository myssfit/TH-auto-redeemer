import {
	Client,
	GatewayIntentBits,
	Partials,
	REST,
	Routes,
	Message,
	type PartialMessage
} from 'discord.js';
import { commands, handleSlashCommand, extractGiftCodesFromText } from './discord-commands.js';
import { enqueueCode, type QueueChannel } from './queue.js';

// Shared path for both new messages and edits
const processMessage = async (message: Message, source: string) => {
	const { author, content, channel, client } = message;

	// 🛑 Ignore ONLY its own messages
	if (author?.id === client.user?.id) return;

	if (!channel.isSendable()) {
		console.error('Cannot send a message through this channel. 😳');
		return;
	}

	console.log(`💬 ${source} from ${author?.globalName} (${author?.id}): ${content}`);

	const giftCodes = extractGiftCodesFromText(content);
	if (giftCodes.length === 0) return;

	console.log(`🎁 Auto-detected ${giftCodes.length} gift code(s): ${giftCodes.join(', ')}`);

	const queued: string[] = [];
	let users = 0;

	for (const giftCode of giftCodes) {
		const added = enqueueCode(giftCode, channel as unknown as QueueChannel);

		if (added === 0) {
			console.log(`ℹ️  ${giftCode} already handled this batch, or no users configured`);
			continue;
		}

		queued.push(giftCode);
		users = Math.max(users, added);
	}

	if (queued.length === 0) return;

	try {
		await channel.send(`🕐 Queued ${queued.map(c => `\`${c}\``).join(', ')} for ${users} user(s) — results posted as each user finishes.`);
	} catch (error) {
		console.error('❌ Could not acknowledge code:', error);
	}
};

const handleMessageCreate = async (message: Message) => {
	await processMessage(message, 'Message');
};

// Fires when a post is edited in place (codes appended to an existing drop)
const handleMessageUpdate = async (
	_oldMessage: Message | PartialMessage,
	newMessage: Message | PartialMessage
) => {
	try {
		// Uncached (pre-restart) messages arrive partial — fetch the full payload first
		const message = newMessage.partial ? await newMessage.fetch() : (newMessage as Message);
		await processMessage(message, 'Edited message');
	} catch (error) {
		console.error('❌ Could not process edited message:', error);
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
		],
		// Required or messageUpdate is silently dropped for uncached (pre-restart) messages
		partials: [
			Partials.Message,
			Partials.Channel
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
	client.on('messageUpdate', handleMessageUpdate);

	await registerCommands(TOKEN);
	await client.login(TOKEN);

	return client;
};
