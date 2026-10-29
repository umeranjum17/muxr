import { readFileSync } from 'node:fs';
import { noteOwnerAuthorization } from '../application/noteOwnerAuthorization.mjs';

const tag = process.argv[process.argv.indexOf('--tag') + 1];
if (!/^v[0-9A-Za-z.-]{1,120}$/.test(tag ?? '')) throw new Error('An exact release tag is required to note its owner authorization');
noteOwnerAuthorization({ tag, notice: readFileSync(process.env.OWNER_AUTHORIZATION_NOTICE_FILE, 'utf8').trim() });
process.stdout.write(`${tag} release notes say it is owner-authorized and not owner-tested\n`);
