#!/usr/bin/env node
import { hashPassword } from '../plugins/cf-backend/src/passwords/index.js';

let input = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) {
  input += chunk;
  if (Buffer.byteLength(input) > 1026) throw new Error('Password is too long');
}
// Strip one terminal newline, not meaningful spaces in the password itself.
const password = input.replace(/\r?\n$/, '');
console.log(await hashPassword(password));
