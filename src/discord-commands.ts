import { SlashCommandBuilder, ChatInputCommandInteraction, type Message } from 'discord.js';
import { userStore } from './user-store.js';
import { useRedeemer } from './redeemer.js';
import { enqueueForUser, getStatus, type QueueChannel } from './queue.js';
import { label } from './labels.js';

// Ignore list for known status/system words even if in backticks
const IGNORED_WORDS = new Set([
	'check', 'added', 'found', 'removed', 'cleared', 'failed', 'success', 
	'user', 'users', 'code', 'codes', 'error', 'invalid', 'expired'
]);

// Helper function to extract gift codes strictly from backticks
export const extractGiftCodesFromText = (message: string): string[] => {
	if (!message) return [];

	const foundCodes = new Set<string>();

	// 'g' flag ensures it scans past all newlines and multi-line headers
	const backtickMatches = message.match(/`\s*([a-zA-Z0-9_-]{5,20})\s*`/g);

	if (backtickMatches) {
		for (const match of backtickMatches) {
			// Strip backticks and trim hidden spaces/newlines
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
		),
	new SlashCommandBuilder()
		.setName('status')
		.setDescription('Show current redemption queue status')
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
			await interaction.reply({ content: `⚠️ ${label(userId)} is already in the list!`, flags: 64 });
			return;
		}

		await interaction.reply({ content: `✅ Added ${label(userId)}! 🔍 Now scanning past channel messages for available gift codes...` });

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

			const queued = enqueueForUser(userId, codeList, channel as unknown as QueueChannel);

			await interaction.followUp({ content: `🎁 Found ${codeList.length} code(s) in channel history: \`${codeList.join(', ')}\`. Queued ${queued} for ${label(userId)} — results will be posted in this channel as they complete.` });
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
			await interaction.reply({ content: `✅ Removed ${label(userId)}.` });
		} else {
			await interaction.reply({ content: `⚠️ ${label(userId)} was not found in the list.`, flags: 64 });
		}
	} else if (commandName === 'list-users') {
		const users = userStore.list();
		if (users.length === 0) {
			await interaction.reply({ content: '📋 No user IDs currently configured.', flags: 64 });
		} else {
			await interaction.reply({ content: `📋 **Configured Users (${users.length}):**\n${users.map(u => `• ${label(u)}`).join('\n')}`, flags: 64 });
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
			await interaction.followUp({ content: `✅ Successfully redeemed \`${code}\` for: ${succeeded.map(id => label(id)).join(', ')}` });
		} else {
			await interaction.followUp({ content: `❌ Failed to redeem \`${code}\` for any users.` });
		}
	} else if (commandName === 'status') {
		const s = getStatus();

		if (s.status === 'idle') {
			await interaction.reply({ content: '💤 **Idle** — no batch in progress.', flags: 64 });
			return;
		}

		const icon = s.status === 'cooldown' ? '🧊' : s.status === 'draining' ? '🚚' : '🗂️';
		const lines: string[] = [`${icon} **${s.status}**`];

		if (s.codes.length > 0) {
			lines.push(`🎁 Codes: ${s.codes.map(c => `\`${c}\``).join(', ')}`);
		}

		lines.push(`👥 Users: ${s.users_done} done · ${s.users_left} left · ${s.users_total} total`);
		lines.push(`📋 Pending pairs: ${s.pending_pairs}`);

		if (s.current_user) {
			lines.push(`▶️ Current user: ${label(s.current_user)}`);
		}

		if (s.cooldown_until) {
			const mins = Math.max(0, Math.ceil((new Date(s.cooldown_until).getTime() - Date.now()) / 60000));
			lines.push(`🧊 Cooldown: ~${mins} min remaining`);
		}

		if (s.batch_started) {
			const mins = Math.floor((Date.now() - new Date(s.batch_started).getTime()) / 60000);
			lines.push(`⏱️ Batch age: ${mins} min`);
		}

		await interaction.reply({ content: lines.join('\n'), flags: 64 });
	}
};
