export function normalizeRecipient(value) {
  const trimmed = String(value).trim();
  if (!trimmed) throw new Error('Recipient cannot be empty');
  if (/^\d{8,15}$/.test(trimmed)) return `${trimmed}@s.whatsapp.net`;
  if (/^[0-9A-Za-z._-]+@(s\.whatsapp\.net|g\.us|newsletter|broadcast)$/.test(trimmed)) return trimmed;
  throw new Error(`Unsupported WhatsApp recipient: ${trimmed}`);
}

export function normalizeRecipients(values) {
  return [...new Set(values.map(normalizeRecipient))];
}
