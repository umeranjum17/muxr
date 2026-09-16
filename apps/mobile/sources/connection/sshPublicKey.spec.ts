import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';

vi.mock('expo-crypto', () => ({
    CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
    // Node's SHA-256 is the same primitive expo-crypto wraps on-device.
    digest: async (_algorithm: string, data: Uint8Array) =>
        new Uint8Array(createHash('sha256').update(data).digest()),
}));

import { sshPublicKeyFromPrivate } from './sshPublicKey';

/**
 * Fixtures generated with ssh-keygen; expected values are its own output
 * (`ssh-keygen -y` public lines, `ssh-keygen -lf` fingerprints). The parser
 * must agree with the reference implementation, not with itself.
 */
const KEY_RSA = `
-----BEGIN RSA PRIVATE KEY-----
MIIEogIBAAKCAQEAu1gbtHYkUR5c/KMoEtGtYI8iZSMJDnw+cWUnyiR7/bWOQWnW
dGLphxfJpa9K/RrwhECttcT06IhN+HY5iWCbIDcmjFAl4w2P58ft3P0ZAQ9JpqhU
X1ovrPjWj/7ZJgv+lxqJ/G/Y1BtrnI0fkx7bxAVUTLA9K9chh1s4myBlyyqoyu9h
t1SNgRSher+GvgmIKWCrOtKxfvQj4HQVyfglZcIgQzpvtHMh+GLdN15gxOFsmLSt
g6IFy4OyhcuZqbzr2Ru0Qes7OekJy07A/IFDZTGsCVamk5/V3o12drRVniO9S/Hp
xMGQBTQqTTIEzbJxvQEP7/DjwGOfb+jkF5E6kwIDAQABAoIBABBeyUJM9ddww8dU
/8dv3aqLrKxnEf+GCR7M1rE/MZEghZG0YdzsV7j08dXcf2emgaXM0Qu1GNbI3Pyn
uAIHwwZe9gCvcDVq60w27X4F+mKxUfTneJfsattpKGE6Gld3bNkJ+fdo/pVqNU5f
YTGbMgZAQPbX35XZHUDqo65Kd8VM3+75ek0DYA6xVaqT6+pV26KYSgxoGQ1kSO+i
diYalJ3z6+H+y8xDNkWpnZq3ch45eOGIBEZeLBjVJMegnbumCCzfT4otbZp6uv+N
8IoIXANGS11w4XfFu9FOI36p+BptWrdktLVowsq1NcVf6KNMh01QTDX9YcXa+QTe
wlkC3AECgYEA7AVJkK55hRZBdVtzSFOUI2S80cu0FSEmFV6UDYl8fQ5SktzOa/HP
vqdPCJPLNSZ8cy/9ymhuuGXbkYcLXP+n7UGGSrNAsjo84EYkhrhrmDO78i6Ea8kp
H4uyXQg9gcrADhuGagOk6OjUF3rXZJ39b7L4eagQz9ip0XrrPTYJjYECgYEAyzP4
uoMWphjd01Dgi/quWMR28Ep8e1a2OuqB5af7oBeinFWsMBaa7hiEom/4Zo1drtRC
hMPzHh2otmNra0NVu4bbm47rwH6ODj0PwlfzyB4axW4IVuUVN9OxOLAVIbXwelit
tvj0eHbp+ekqu7MFxksFHxbeeqMlzEuLyIIMuhMCgYBDj5/nUopmlmBWf78YTRRy
rTt/spfyFHMaWuB2n4yLH7ZzY9GTBL07DhmJkwTwSfwF3Q8BCbPoBQA9QDL4hBZF
zCPs7jLu0czrRijeh5wFDYoXYUl2sTacWRjNmLZCmQ8w+qAXaMOkCEHuFrPhkXgi
qVCHQpzNYm/6Dv2XoAhMAQKBgDprCZHNSACeW3952+RCQEdCzBLOxzTKO/96FbgJ
cByZTuV099inVwkmQVNVr2sELy+o1CrJDqbUzgEJWgNvS0FrRs1U7E/d0kcjpNkx
YeNhTD8AICOjHlN7Z5KthJW5cZYq0l4s+lN7lE6FiwSFNh7IyIMklvdY2e/+tAQD
51bDAoGAYPALbf6DSckdarT8ffWXGyfr5eDBvv+5FYa2ZwLDjW/FLFpyz9JajYa6
X1LNNFiShFr/Eq+4cRBsduPeD5/RcsW+jgU9tBLXOpT9DCLVoaj+9ME+RsoOCRe6
JNiTi+bOnKfwm/Gnv9Odcs1P/Ub0Lfev4lx7IWoIhEhVVFgRZ64=
-----END RSA PRIVATE KEY-----`;
const KEY_RSA8 = `
-----BEGIN PRIVATE KEY-----
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQC7WBu0diRRHlz8
oygS0a1gjyJlIwkOfD5xZSfKJHv9tY5BadZ0YumHF8mlr0r9GvCEQK21xPToiE34
djmJYJsgNyaMUCXjDY/nx+3c/RkBD0mmqFRfWi+s+NaP/tkmC/6XGon8b9jUG2uc
jR+THtvEBVRMsD0r1yGHWzibIGXLKqjK72G3VI2BFKF6v4a+CYgpYKs60rF+9CPg
dBXJ+CVlwiBDOm+0cyH4Yt03XmDE4WyYtK2DogXLg7KFy5mpvOvZG7RB6zs56QnL
TsD8gUNlMawJVqaTn9XejXZ2tFWeI71L8enEwZAFNCpNMgTNsnG9AQ/v8OPAY59v
6OQXkTqTAgMBAAECggEAEF7JQkz113DDx1T/x2/dqousrGcR/4YJHszWsT8xkSCF
kbRh3OxXuPTx1dx/Z6aBpczRC7UY1sjc/Ke4AgfDBl72AK9wNWrrTDbtfgX6YrFR
9Od4l+xq22koYToaV3ds2Qn592j+lWo1Tl9hMZsyBkBA9tffldkdQOqjrkp3xUzf
7vl6TQNgDrFVqpPr6lXbophKDGgZDWRI76J2JhqUnfPr4f7LzEM2RamdmrdyHjl4
4YgERl4sGNUkx6Cdu6YILN9Pii1tmnq6/43wighcA0ZLXXDhd8W70U4jfqn4Gm1a
t2S0tWjCyrU1xV/oo0yHTVBMNf1hxdr5BN7CWQLcAQKBgQDsBUmQrnmFFkF1W3NI
U5QjZLzRy7QVISYVXpQNiXx9DlKS3M5r8c++p08Ik8s1JnxzL/3KaG64ZduRhwtc
/6ftQYZKs0CyOjzgRiSGuGuYM7vyLoRrySkfi7JdCD2BysAOG4ZqA6To6NQXetdk
nf1vsvh5qBDP2KnReus9NgmNgQKBgQDLM/i6gxamGN3TUOCL+q5YxHbwSnx7VrY6
6oHlp/ugF6KcVawwFpruGISib/hmjV2u1EKEw/MeHai2Y2trQ1W7htubjuvAfo4O
PQ/CV/PIHhrFbghW5RU307E4sBUhtfB6WK22+PR4dun56Sq7swXGSwUfFt56oyXM
S4vIggy6EwKBgEOPn+dSimaWYFZ/vxhNFHKtO3+yl/IUcxpa4HafjIsftnNj0ZME
vTsOGYmTBPBJ/AXdDwEJs+gFAD1AMviEFkXMI+zuMu7RzOtGKN6HnAUNihdhSXax
NpxZGM2YtkKZDzD6oBdow6QIQe4Ws+GReCKpUIdCnM1ib/oO/ZegCEwBAoGAOmsJ
kc1IAJ5bf3nb5EJAR0LMEs7HNMo7/3oVuAlwHJlO5XT32KdXCSZBU1WvawQvL6jU
KskOptTOAQlaA29LQWtGzVTsT93SRyOk2TFh42FMPwAgI6MeU3tnkq2ElblxlirS
Xiz6U3uUToWLBIU2HsjIgySW91jZ7/60BAPnVsMCgYBg8Att/oNJyR1qtPx99Zcb
J+vl4MG+/7kVhrZnAsONb8UsWnLP0lqNhrpfUs00WJKEWv8Sr7hxEGx2494Pn9Fy
xb6OBT20Etc6lP0MItWhqP70wT5Gyg4JF7ok2JOL5s6cp/Cb8ae/051yzU/9RvQt
96/iXHshagiESFVUWBFnrg==
-----END PRIVATE KEY-----`;
const KEY_EC = `
-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAaAAAABNlY2RzYS
1zaGEyLW5pc3RwMjU2AAAACG5pc3RwMjU2AAAAQQSBJVmtDL7YcRKfKXrVdE+CNZeu9aba
0DHy7sYZXNocieGWGXXRVKo+gnI9m7CSifzIZ3Ytv6DjURCVWhtMk25RAAAAoENWB7lDVg
e5AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBIElWa0MvthxEp8p
etV0T4I1l671ptrQMfLuxhlc2hyJ4ZYZddFUqj6Ccj2bsJKJ/Mhndi2/oONREJVaG0yTbl
EAAAAhANSd86V4Lr56ORVX6TevfdqyAkU8AhRPCWb8uInAnUx0AAAAAAECAwQFBgc=
-----END OPENSSH PRIVATE KEY-----`;
const KEY_EC8 = `
-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg1J3zpXguvno5FVfp
N6992rICRTwCFE8JZvy4icCdTHShRANCAASBJVmtDL7YcRKfKXrVdE+CNZeu9aba
0DHy7sYZXNocieGWGXXRVKo+gnI9m7CSifzIZ3Ytv6DjURCVWhtMk25R
-----END PRIVATE KEY-----`;
const KEY_EC5915 = `
-----BEGIN EC PRIVATE KEY-----
MHcCAQEEINSd86V4Lr56ORVX6TevfdqyAkU8AhRPCWb8uInAnUx0oAoGCCqGSM49
AwEHoUQDQgAEgSVZrQy+2HESnyl61XRPgjWXrvWm2tAx8u7GGVzaHInhlhl10VSq
PoJyPZuwkon8yGd2Lb+g41EQlVobTJNuUQ==
-----END EC PRIVATE KEY-----`;
const KEY_ED = `
-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW
QyNTUxOQAAACDzDL43CKGM7mgUl294RTLqFR3vRMrpfS6gob9xt0VXVwAAAIiWZwmXlmcJ
lwAAAAtzc2gtZWQyNTUxOQAAACDzDL43CKGM7mgUl294RTLqFR3vRMrpfS6gob9xt0VXVw
AAAEBkIHA4qpTAX1tlts7kmHofQolTKKjMbTyKVtmW6PhUXPMMvjcIoYzuaBSXb3hFMuoV
He9Eyul9LqChv3G3RVdXAAAAAAECAwQF
-----END OPENSSH PRIVATE KEY-----`;
const EXPECTED = {
    RSA: { algorithm: 'ssh-rsa', publicKey: 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQC7WBu0diRRHlz8oygS0a1gjyJlIwkOfD5xZSfKJHv9tY5BadZ0YumHF8mlr0r9GvCEQK21xPToiE34djmJYJsgNyaMUCXjDY/nx+3c/RkBD0mmqFRfWi+s+NaP/tkmC/6XGon8b9jUG2ucjR+THtvEBVRMsD0r1yGHWzibIGXLKqjK72G3VI2BFKF6v4a+CYgpYKs60rF+9CPgdBXJ+CVlwiBDOm+0cyH4Yt03XmDE4WyYtK2DogXLg7KFy5mpvOvZG7RB6zs56QnLTsD8gUNlMawJVqaTn9XejXZ2tFWeI71L8enEwZAFNCpNMgTNsnG9AQ/v8OPAY59v6OQXkTqT', fingerprint: 'SHA256:Vu2SH93IzyLz2ZesrWBf+0ygngcX+O5uFytBbx1kCY0' },
    EC: { algorithm: 'ecdsa-sha2-nistp256', publicKey: 'ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBIElWa0MvthxEp8petV0T4I1l671ptrQMfLuxhlc2hyJ4ZYZddFUqj6Ccj2bsJKJ/Mhndi2/oONREJVaG0yTblE=', fingerprint: 'SHA256:9c0wtM1YEj1ajZmHmtBgv5sPN+BAitITBdiVK5Jr8LA' },
    ED: { algorithm: 'ssh-ed25519', publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPMMvjcIoYzuaBSXb3hFMuoVHe9Eyul9LqChv3G3RVdX', fingerprint: 'SHA256:dIjfaWbaccr/E0N2mzBFfmVJE1B2pdGdhOCcVsDzePo' },
} as const;

describe('sshPublicKeyFromPrivate', () => {
    it('matches ssh-keygen for a PKCS#1 RSA key', async () => {
        await expect(sshPublicKeyFromPrivate(KEY_RSA)).resolves.toEqual(EXPECTED.RSA);
    });

    it('matches ssh-keygen for a PKCS#8 RSA key', async () => {
        await expect(sshPublicKeyFromPrivate(KEY_RSA8)).resolves.toEqual(EXPECTED.RSA);
    });

    it('matches ssh-keygen for an OpenSSH-format EC key', async () => {
        await expect(sshPublicKeyFromPrivate(KEY_EC)).resolves.toEqual(EXPECTED.EC);
    });

    it('matches ssh-keygen for a PKCS#8 EC key', async () => {
        await expect(sshPublicKeyFromPrivate(KEY_EC8)).resolves.toEqual(EXPECTED.EC);
    });

    it('matches ssh-keygen for an RFC 5915 EC key', async () => {
        await expect(sshPublicKeyFromPrivate(KEY_EC5915)).resolves.toEqual(EXPECTED.EC);
    });

    it('matches ssh-keygen for an OpenSSH ed25519 key', async () => {
        await expect(sshPublicKeyFromPrivate(KEY_ED)).resolves.toEqual(EXPECTED.ED);
    });

    it('returns undefined for truncated or non-key input', async () => {
        await expect(sshPublicKeyFromPrivate('not a key')).resolves.toBeUndefined();
        await expect(sshPublicKeyFromPrivate(KEY_ED.slice(0, 80))).resolves.toBeUndefined();
    });
});
