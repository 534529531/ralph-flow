export const DONE_TAG = /<promise>\s*done\s*<\/promise>/i;
export const CHECK_TAG = /<promise-check>\s*(true|false)\s*<\/promise-check>/i;

export function detectDoneTag(text: string): boolean {
  return DONE_TAG.test(text);
}

export function detectCheckTag(text: string): boolean | null {
  const match = text.match(CHECK_TAG);
  if (!match) return null;
  return match[1].toLowerCase() === "true";
}
