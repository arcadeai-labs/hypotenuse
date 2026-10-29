/**
 * A bot's avatar, on its way up: what the server accepts, checked before the
 * upload so a person hears about a wrong file at once, and the file read into
 * the base64 `bot:edit` takes. The server checks again — the type from the
 * bytes and that the image is square — and its refusal is what a person reads
 * for anything this does not catch.
 */

/** The largest avatar the server accepts, in bytes. */
export const MAX_AVATAR_BYTES = 512 * 1024;

/** The image types an avatar may be. */
export const AVATAR_TYPES = ["image/png", "image/jpeg"] as const;

/** What the file input offers: the same types, by extension too. */
export const AVATAR_ACCEPT = "image/png,image/jpeg,.png,.jpg,.jpeg";

/**
 * Why a file cannot be an avatar, or `null` when it may be sent.
 * @param file - The file's declared type and its size in bytes.
 * @returns A sentence naming the problem and what to send instead, or `null`.
 */
export function avatarProblem(file: {
  type: string;
  size: number;
}): string | null {
  if (!(AVATAR_TYPES as readonly string[]).includes(file.type)) {
    return "An avatar must be a PNG or JPEG image.";
  }
  if (file.size > MAX_AVATAR_BYTES) {
    return `That image is ${Math.ceil(file.size / 1024)} KB; an avatar is at most ${MAX_AVATAR_BYTES / 1024} KB.`;
  }
  if (file.size === 0) return "That file is empty.";
  return null;
}

/**
 * Encode bytes as base64, in slices, so a large file never becomes one
 * enormous argument list.
 * @param bytes - The bytes.
 * @returns The base64 text, without a `data:` prefix.
 */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const slice = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += slice) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + slice));
  }
  return btoa(binary);
}

/**
 * Check a chosen file and read it as base64 for `bot:edit`'s `avatar`.
 * @param file - The file the person picked.
 * @returns The base64 text.
 * @throws {Error} With {@link avatarProblem}'s sentence when it cannot be an avatar.
 */
export async function readAvatar(file: Blob): Promise<string> {
  const problem = avatarProblem(file);
  if (problem) throw new Error(problem);
  return bytesToBase64(new Uint8Array(await file.arrayBuffer()));
}

/**
 * Where the browser reads a bot's avatar: the API origin plus the path the
 * server reports, which already carries a version that changes on upload.
 * @param apiUrl - The API origin, `API_URL`.
 * @param avatarUrl - `bot.avatarUrl`, a path beneath `/api`, or `null`.
 * @returns The image URL, or `undefined` when the bot has none.
 */
export function botAvatarSrc(
  apiUrl: string,
  avatarUrl: string | null,
): string | undefined {
  return avatarUrl ? `${apiUrl}/api${avatarUrl}` : undefined;
}
