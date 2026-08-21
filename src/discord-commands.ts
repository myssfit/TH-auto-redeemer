import { SlashCommandBuilder, ChatInputCommandInteraction } from 'discord.js';
import { userStore } from './user-store.js';
import { useRedeemer } from './redeemer.js';

// Helper function to extract gift codes from chat messages
const extractGiftCodesFromText = (message) => {
	if (!message) return [];

	const cleanMessage = message.replace(/[`*~_]/g, ' ').trim();
	const foundCodes = new Set();

	// 1. Check for labeled codes
	const labeledPattern = /(?:gift\s*code(?:\s*\d+)?|code|cd|🎁)[\s:#=-]*([a-zA-Z0-9]{5,20})\b/gi;
	let match;
	while ((match = labeledPattern.exec(cleanMessage)) !== null) {
		foundCodes.add(match[1]);
	}

	// 2. Check for standalone alphanumeric words
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
			foundCodes.add(clean);
		}
	}

	return Array.from(foundCodes);
};

export const commands = [
	new SlashCommandBuilder()
		.setName('add-user')
		.setDescription('Add a user ID for auto-redemption and redeem past channel codes')
		.addStringOption(option =>
			option.setName('user-id')
				.setDescription('The Top Heroes numeric User ID (UID)')
				.setRequired(true)
		),
	new SlashCommandBuilder()
		.setName('remove-user')
		.setDescription('Remove a user ID from auto-redemption')
		.addStringOption(option =>
			option.setName('user-id')
				.setDescription('The Top Heroes numeric User ID (UID) to remove')
				.setRequired(true)
		),
	new SlashCommandBuilder()
		.setName('list-users')
		.setDescription('List all configured user IDs'),
	new SlashCommandBuilder()
		.setName('clear-users')
		.setDescription('Clear all configured user IDs'),
	new SlashCommandBuilder()
		.setName('redeem')
		.setDescription('Manually redeem a gift code for all users')
		.addStringOption(option =>
			option.setName('code')
				.setDescription('The gift code to redeem')
				.setRequired(true)
		)
].map(command => command.toJSON());

export const handleSlashCommand = async (interaction) => {
	const { commandName, options, channel } = interaction;

	if (commandName === 'add-user') {
		const userId = options.getString('user-id')?.trim();

		if (!userId || !/^\d+$/.test(userId)) {
			await interaction.reply({ content: '❌ Invalid User ID. Please provide a numeric UID.', flags: 64 });
			return;
		}

		const added = userStore.add(userId);
		if (!added) {
			await interaction.reply({ content: `⚠️ User ID \`${userId}\` is already in the list!`, flags: 64 });
			return;
		}

		// Acknowledge the add right away
		await interaction.reply({ content: `✅ Added user ID \`${userId}\`! 🔍 Now scanning past channel messages for available gift codes...` });

		// Fetch past 100 messages from the code channel to catch existing codes
		try {
			const messages = await channel.messages.fetch({ limit: 100 });
			const historicalCodes = new Set();

			for (const msg of messages.values()) {
				// Skip bot's own status messages
				if (msg.author.id === interaction.client.user.id) continue;

				let fullText = msg.content || '';
				if (msg.embeds && msg.embeds.length > 0) {
					for (const embed of msg.embeds) {
						if (embed.title) fullText += `\n${embed.title}`;
						if (embed.description) fullText += `\n${embed.description}`;
					}
				}

				const codes = extractGiftCodesFromText(fullText);
				codes.forEach(c => historicalCodes.add(c));
			}

			const codeList = Array.from(historicalCodes);

			if (codeList.length === 0) {
				await interaction.followUp({ content: `ℹ️ No past gift codes found in the last 100 channel messages.` });
				return;
			}

			await interaction.followUp({ content: `🎁 Found ${codeList.length} code(s) in channel history: \`${codeList.join(', ')}\`. Attempting redemption for \`${userId}\`...` });

			const { redeem } = useRedeemer();
			const successfulRedeems = [];

			for (const code of codeList) {
				const success = await redeem(code, userId);
				if (success) {
					successfulRedeems.push(code);
				}
				// Small delay between code redemptions to prevent API rate limits
				await new Promise(r => setTimeout(r, 1500));
			}

			if (successfulRedeems.length > 0) {
				await interaction.followUp({ content: `🎉 Successfully retroactively claimed ${successfulRedeems.length} code(s) for \`${userId}\`: \`${successfulRedeems.join(', ')}\`` });
			} else {
				await interaction.followUp({ content: `ℹ️ Historical code check complete for \`${userId}\`. (Codes were either expired or already claimed).` });
			}

		} catch (error) {
			console.error('Error scanning channel history:', error);
			await interaction.followUp({ content: `⚠️ User added, but encountered an error scanning channel history for codes.` });
		}
	} else if (commandName === 'remove-user') {
		const userId = options.getString('user-id')?.trim();
		const removed = userStore.remove(userId);
		if (removed) {
			await interaction.reply({ content: `✅ Removed user ID \`${userId}\`.` });
		} else {
			await interaction.reply({ content: `⚠️ User ID \`${userId}\` was not found in the list.`, flags: 64 });
		}
	} else if (commandName === 'list-users') {
		const users = userStore.list();
		if (users.length === 0) {
			await interaction.reply({ content: '📋 No user IDs currently configured.', flags: 64 });
		} else {
			await interaction.reply({ content: `📋 **Configured User IDs (${users.length}):**\n${users.map(u => `• \`${u}\``).join('\n')}`, flags: 64 });
		}
	} else if (commandName === 'clear-users') {
		userStore.clear();
		await interaction.reply({ content: '🗑️ Cleared all user IDs.' });
	} else if (commandName === 'redeem') {
		const code = options.getString('code')?.trim();
		await interaction.reply({ content: `🎁 Manually triggering redemption for code: \`${code}\`...` });
		const { redeemForAll } = useRedeemer();
		const succeeded = await redeemForAll(code);
		if (succeeded.length > 0) {
			await interaction.followUp({ content: `✅ Successfully redeemed \`${code}\` for: ${succeeded.map(id => `\`${id}\``).join(', ')}` });
		} else {
			await interaction.followUp({ content: `❌ Failed to redeem \`${code}\` for any users.` });
		}
	}
};
