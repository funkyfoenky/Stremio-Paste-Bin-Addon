// Utilitaires pour les codes pastebin (hex ou alphanumériques, 8 caractères)
const PASTE_CODE_PATTERN = /^[a-zA-Z0-9]{8}$/;

function isValidPasteCode(code) {
  return typeof code === 'string' && PASTE_CODE_PATTERN.test(code.trim());
}

function extractPasteCodesFromContent(content) {
  if (!content) return [];

  const lines = content.split('\n').map(line => line.trim()).filter(line => line !== '');
  const codes = [];
  const seen = new Set();

  for (const line of lines) {
    const segments = line.includes('|') ? line.split('|') : [line];
    for (const segment of segments) {
      const trimmed = segment.trim();
      if (isValidPasteCode(trimmed) && !seen.has(trimmed)) {
        seen.add(trimmed);
        codes.push(trimmed);
      }
    }
  }

  return codes;
}

function isPasteContainerPage(content, extractedCodes) {
  const lines = content.split('\n').map(line => line.trim()).filter(line => line !== '');
  const hasCommentHeader = lines.some(line => line.includes('#'));
  const codeRatio = extractedCodes.length / Math.max(lines.length, 1);

  return extractedCodes.length > 0 && (
    hasCommentHeader ||
    codeRatio >= 0.5 ||
    lines.length === extractedCodes.length
  );
}

module.exports = {
  isValidPasteCode,
  extractPasteCodesFromContent,
  isPasteContainerPage
};
