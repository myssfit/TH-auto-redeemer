// Maps Top Heroes UIDs to friendly names for Discord output only.
// Console logs keep raw UIDs so debugging stays unambiguous.
//
// Render env var format:
//   USER_LABELS=1786414180826=Main,1784873101786=Alt1,1791031650780=Farm3
//
// Google Sheet formula (col A = name, col B = UID):
//   =TEXTJOIN(",",TRUE,ARRAYFORMULA(IF(B2:B<>"",B2:B&"="&A2:A,"")))

const parseLabels = (raw: string | undefined): Map<string, string> => {
	const map = new Map<string, string>();
	if (!raw) return map;

	for (const entry of raw.split(',')) {
		const [uid, ...rest] = entry.split('=');
		const key = uid?.trim();
		const name = rest.join('=').trim();
		if (key && name) map.set(key, name);
	}

	return map;
};

const labels = parseLabels(process.env.USER_LABELS);

if (labels.size > 0) {
	console.log(`🏷️  Loaded ${labels.size} user label(s)`);
} else {
	console.log('🏷️  No USER_LABELS set — Discord output will show raw UIDs');
}

// Friendly name if known, otherwise the raw UID.
export const label = (userId: string): string => labels.get(userId) ?? userId;

// Friendly name with UID in parentheses, for lists where you want both.
export const labelWithId = (userId: string): string => {
	const name = labels.get(userId);
	return name ? `${name} (${userId})` : userId;
};
