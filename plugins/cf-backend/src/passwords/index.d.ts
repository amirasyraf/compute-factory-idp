export function hashPassword(password: string): Promise<string>;
export function verifyPassword(
  password: string,
  hash?: string,
): Promise<boolean>;
export function readUsers(encoded?: string): Map<string, string>;
export function verifyUserPassword(
  users: ReadonlyMap<string, string>,
  username: string,
  password: string,
): Promise<boolean>;
