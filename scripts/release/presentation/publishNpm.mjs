import { existsSync, readFileSync } from 'node:fs';
import { publishNpm } from '../application/publishNpm.mjs';

// An owner-authorized publication says so in the log that records it, before and after the upload.
const noticeFile = process.env.OWNER_AUTHORIZATION_NOTICE_FILE;
const notice = noticeFile && existsSync(noticeFile) ? readFileSync(noticeFile, 'utf8').trim() : undefined;
if (notice) process.stdout.write(`${notice}\n`);
await publishNpm();
if (notice) process.stdout.write(`${notice}\n`);
