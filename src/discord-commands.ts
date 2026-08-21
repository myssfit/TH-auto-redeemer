import { SlashCommandBuilder, ChatInputCommandInteraction, type Message } from 'discord.js';
import { userStore } from './user-store.js';
import { useRedeemer } from './redeemer.js';

// Ignore list for known status/system words even if in backticks
const IGNORED_WORDS = new Set([
	'check', 'added', 'found', 'removed', 'cleared', 'failed', 'success', 
	'user', 'users', 'code', 'codes', 'error', 'invalid', 'expired'
]);

// Helper function to extract gift codes strictly from backticks
export const extractGiftCodesFromText = (message: string): string[] => {
	if (!message) return [];

	const foundCodes = new Set<string>();

	// Target ONLY text inside backticks: `CODE_HERE`
	const backtickMatches = message.match(/`([a-zA-Z0-9]{5,20})`/g);

	if (backtickMatches) {
		for (const match of backtickMatches) {
			const cleanCode = match.replace(/`/g, '').trim();

			if (!IGNORED_WORDS.has(cleanCode.toLowerCase()) && !cleanCode.startsWith('http')) {
				foundCodes.add(cleanCode);
			}
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

export const handleSlashCommand = async (interaction: ChatInputCommandInteraction) => {
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

		await interaction.reply({ content: `✅ Added user ID \`${userId}\`! 🔍 Now scanning past channel messages for available gift codes...` });

		try {
			if (!channel || !('messages' in channel)) {
				await interaction.followUp({ content: '⚠️ User added, but could not fetch channel message history.' });
				return;
			}

			const messages = await channel.messages.fetch({ limit: 100 });
			const historicalCodes = new Set<string>();

			for (const msg of messages.values()) {
				const typedMsg = msg as Message;
				// Ignore ONLY itself during history scan
				if (typedMsg.author.id === interaction.client.user?.id) continue;

				let fullText = typedMsg.content || '';
				if (typedMsg.embeds && typedMsg.embeds.length > 0) {
					for (const embed of typedMsg.embeds) {
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
			const successfulRedeems: string[] = [];

			for (const code of codeList) {
				const success = await redeem(code, userId);
				if (success) {
					successfulRedeems.push(code);
				}
				// 4-second delay between historical codes to prevent API bans
				await new Promise(r => setTimeout(r, 4000));
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
		const rawUserId = options.getString('user-id');
		if (!rawUserId) {
			await interaction.reply({ content: '❌ Please provide a user ID.', flags: 64 });
			return;
		}
		const userId = rawUserId.trim();
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
		const rawCode = options.getString('code');
		if (!rawCode) {
			await interaction.reply({ content: '❌ Please provide a gift code.', flags: 64 });
			return;
		}
		const code = rawCode.trim();
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
