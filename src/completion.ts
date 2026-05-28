export const DONE_TAG = /<promise>\s*done\s*<\/promise>/i;
export const CHECK_TAG = /<promise-check>\s*(true|false)\s*<\/promise-check>/i;

export function detectDoneTag(text: string): boolean {
  if (!text) return false;
  
  const trimmed = text.trim();
  
  // Check if done tag is on the last line (most reliable)
  const lines = trimmed.split("\n");
  const lastLine = lines[lines.length - 1].trim();
  if (DONE_TAG.test(lastLine)) {
    return true;
  }
  
  // Also check if it's at the end of the text (within last 100 chars)
  const lastPart = trimmed.substring(Math.max(0, trimmed.length - 100));
  return DONE_TAG.test(lastPart);
}

export function detectCheckTag(text: string): boolean | null {
  const match = text.match(CHECK_TAG);
  if (!match) return null;
  return match[1].toLowerCase() === "true";
}
