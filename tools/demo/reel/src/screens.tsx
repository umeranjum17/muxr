import React from 'react';
import { interpolate, spring, useCurrentFrame } from 'remotion';
import { FPS, GREEN, TOKENS, starts } from './config';
import { MONO, SANS } from './fonts';

// The screens, typeset. Same job, same diff, same numbers as the take —
// but drawn, not filmed: no wraps, no banners, no cut letters.
//
// The phone half is set in the app's own design system, lifted from
// apps/mobile/sources/theme.ts and the shipping components — the film's
// pixels are the product's pixels.

const TXT = '#d6d6d8';
const DIM = '#87878c';
const FAINT = '#5a5a5f';
const RED = '#ff6b60';
const BLU = '#6cb2ff';

// The app's dark theme, verbatim.
const APP = {
    bg: '#000000',          // groupped/header background
    surface: '#1a1a1a',
    high: '#212121',
    divider: '#2e2e2e',
    text: '#ececec',
    sub: '#9a9a9f',
    section: '#8E8E93',
    chevron: '#505050',
    termBg: '#1E1E1E',
    working: '#0A84FF',
    done: '#30D158',
    blocked: '#FF453A',
    idle: '#8E8E93',
    waiting: '#f38ba8',
    success: '#94e2d5',
};
const DIFF = {
    outline: '#30363D', header: '#161B22', hunkText: '#58A6FF',
    addedBg: '#12331F', addedText: '#7EE787',
    removedBg: '#3A1D22', removedText: '#FFA198',
    lineNo: '#6E7681', context: '#8B949E',
};

const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;

/** One terminal line fading in at its moment (global frames). */
const Line: React.FC<{ at: number; children?: React.ReactNode }> = ({ at, children }) => {
    const frame = useCurrentFrame();
    const o = interpolate(frame, [at, at + 5], [0, 1], clamp);
    return <div style={{ opacity: o, whiteSpace: 'pre' }}>{children ?? '\u00a0'}</div>;
};

/** A block arriving on the object spring: fade plus a small rise. */
const Rise: React.FC<{ at: number; children: React.ReactNode; style?: React.CSSProperties }> =
    ({ at, children, style }) => {
        const frame = useCurrentFrame();
        const p = frame < at ? 0 : spring({ frame: frame - at, fps: FPS, config: TOKENS.motion.object });
        return (
            <div style={{
                ...style, opacity: Math.min(1, p * 1.4),
                transform: `translateY(${(10 * (1 - p)).toFixed(2)}px)`,
            }}>{children}</div>
        );
    };

const S: React.FC<{ c?: string; children: React.ReactNode }> = ({ c, children }) => (
    <span style={{ color: c ?? TXT }}>{children}</span>
);

/** Full-screen states that crossfade — the screen skips time, softly. */
const Cross: React.FC<{ states: Array<{ at: number; el: React.ReactNode }> }> = ({ states }) => {
    const frame = useCurrentFrame();
    let i = 0;
    for (let k = 0; k < states.length; k += 1) if (frame >= states[k].at) i = k;
    const fade = i === 0 ? 1 : interpolate(frame, [states[i].at, states[i].at + 8], [0, 1], clamp);
    return (
        <>
            {i > 0 && fade < 1
                ? <div style={{ position: 'absolute', inset: 0 }}>{states[i - 1].el}</div> : null}
            <div style={{ position: 'absolute', inset: 0, opacity: fade }}>{states[i].el}</div>
        </>
    );
};

const Blink: React.FC = () => {
    const frame = useCurrentFrame();
    return (
        <span style={{
            display: 'inline-block', width: '0.55em', height: '1.1em',
            background: TXT, verticalAlign: 'text-bottom',
            opacity: Math.floor(frame / 30) % 2 === 0 ? 1 : 0,
        }} />
    );
};

// ------------------------------------------------------------------ desk

const Term: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <div style={{
        position: 'absolute', inset: 0, padding: '30px 34px',
        fontFamily: MONO, fontSize: 19, lineHeight: '30px', color: TXT,
    }}>{children}</div>
);

const PromptBlock: React.FC<{ at: number }> = ({ at }) => (
    <>
        <Line at={at}><S>● </S><S>Bash</S><S c={DIM}>(pnpm test)</S></Line>
        <Line at={at + 4}><S c={DIM}>  ⎿  Run the test suite</S></Line>
        <Line at={at + 8} />
        <Line at={at + 10}><S>This command requires approval</S></Line>
        <Line at={at + 14} />
        <Line at={at + 16}><S>Do you want to proceed?</S></Line>
        <Line at={at + 20}><S c={GREEN}>❯ 1. Yes</S></Line>
        <Line at={at + 24}><S c={DIM}>  2. Yes, and don't ask again for: pnpm test</S></Line>
        <Line at={at + 28}><S c={DIM}>  3. No</S></Line>
        <Line at={at + 32} />
        <Line at={at + 34}><S c={FAINT}>Esc to cancel · Tab to amend</S> <Blink /></Line>
    </>
);

const DeskWork: React.FC = () => {
    const a = 6;
    return (
        <Term>
            <div style={{ height: 90 }} />
            <Line at={a}><S c={GREEN}>❯ </S><S>claude "Fix the refresh-token race and run the auth tests"</S></Line>
            <Line at={a + 10} />
            <Line at={a + 12}><S>● I read src/auth/token-store.ts. The race is in rotate():</S></Line>
            <Line at={a + 16}><S>  the token is checked, then issue() is awaited before the</S></Line>
            <Line at={a + 20}><S>  old token is retired — two concurrent redemptions both</S></Line>
            <Line at={a + 24}><S>  pass the same check.</S></Line>
            <Line at={a + 32} />
            <Line at={a + 38}><S>● </S><S>Update</S><S c={DIM}>(src/auth/token-store.ts)</S></Line>
            <Line at={a + 44}><S c={DIM}>  ⎿  Updated token-store.ts with 4 additions and 2 removals</S></Line>
            <Line at={a + 52} />
            <Line at={a + 56}><S c={FAINT}>     81   </S><S>async rotate(refresh: string): Promise&lt;string&gt; {'{'}</S></Line>
            <Line at={a + 62}><S c={FAINT}>     82     </S><S>const subject = this.subjectOf(refresh);</S></Line>
            <Line at={a + 68}><S c={FAINT}>     83 </S><S c={RED}>-   const next = await this.issue(subject);</S></Line>
            <Line at={a + 74}><S c={FAINT}>     84 </S><S c={RED}>-   return next;</S></Line>
            <Line at={a + 82}><S c={FAINT}>     83 </S><S c={GREEN}>+   // Retire before the first await, or a concurrent</S></Line>
            <Line at={a + 88}><S c={FAINT}>     84 </S><S c={GREEN}>+   // redemption passes the same check.</S></Line>
            <Line at={a + 94}><S c={FAINT}>     85 </S><S c={GREEN}>+   this.invalidate(refresh);</S></Line>
            <Line at={a + 100}><S c={FAINT}>     86 </S><S c={GREEN}>+   return this.issue(subject);</S></Line>
            <Line at={a + 106}><S c={FAINT}>     87   </S><S>{'}'}</S></Line>
        </Term>
    );
};

const DeskTests: React.FC = () => {
    const a = starts.fix + 8;
    return (
        <Term>
            <Line at={a}><S>● </S><S>Update</S><S c={DIM}>(tests/auth/session.test.ts)</S></Line>
            <Line at={a + 6}><S c={DIM}>  ⎿  Added 3 tests</S></Line>
            <Line at={a + 12} />
            <Line at={a + 16}><S c={FAINT}>     </S><S>it(</S><S c={GREEN}>'refuses a second redemption of the same token'</S><S>)</S></Line>
            <Line at={a + 24}><S c={FAINT}>     </S><S>it(</S><S c={GREEN}>'lets only one of two concurrent redemptions win'</S><S>)</S></Line>
            <Line at={a + 32}><S c={FAINT}>     </S><S>it(</S><S c={GREEN}>'retires the refresh token in the same tick'</S><S>)</S></Line>
            <Line at={a + 42} />
            <Line at={a + 48}><S>● 23 tests before, 26 after — the three new ones fail</S></Line>
            <Line at={a + 52}><S>  against the old rotate(). Running the suite proves it.</S></Line>
        </Term>
    );
};

const DeskWall: React.FC = () => {
    const a = starts.wall + 6;
    return (
        <Term>
            <Line at={a}><S c={FAINT}>     it('retires the refresh token in the same tick')</S></Line>
            <Line at={a} />
            <Line at={a + 2}><S c={DIM}>✶ Unravelling… (esc to interrupt)</S></Line>
            <div style={{ height: 260 }} />
            <PromptBlock at={a + 8} />
        </Term>
    );
};

/** After the tap: the run, streamed, then the verdict. */
export const deskAck = starts.approval + 120 + TOKENS.ack.latency;
const runAt = starts.approval + 150;
const DeskRun: React.FC = () => {
    const a = deskAck;
    const r = runAt;
    const v = starts.result + 10;
    return (
        <Term>
            <Line at={a}><S>● </S><S>Bash</S><S c={DIM}>(pnpm test)</S></Line>
            <Line at={a + 4}><S c={GREEN}>  ⎿  </S><S c={DIM}>$ pnpm test</S></Line>
            <Line at={a + 12} />
            <Line at={a + 16}><S c={BLU}> RUN </S><S c={DIM}> v3.2.4  /var/tmp/muxr-demo</S></Line>
            <Line at={a + 24} />
            <Line at={r + 10}><S c={DIM}> · tests/auth/token-store.test.ts (9 tests)</S></Line>
            <Line at={r + 46}><S c={GREEN}> ✓ </S><S>tests/auth/token-store.test.ts </S><S c={DIM}>(9 tests) 84ms</S></Line>
            <Line at={r + 66}><S c={DIM}> · tests/auth/session.test.ts (17 tests)</S></Line>
            <Line at={r + 132}><S c={GREEN}> ✓ </S><S>tests/auth/session.test.ts </S><S c={DIM}>(17 tests) 312ms</S></Line>
            <Line at={r + 150} />
            <Line at={r + 168}><S c={DIM}> Test Files  </S><S c={GREEN}>2 passed</S><S c={DIM}> (2)</S></Line>
            <Line at={r + 176}><S c={DIM}>      Tests  </S><S c={GREEN}>26 passed</S><S c={DIM}> (26)</S></Line>
            <Line at={r + 184}><S c={DIM}>   Duration  1.42s</S></Line>
            <Line at={r + 196} />
            <Line at={v}><S>● pnpm test: 26 passed. The refresh-token race is fixed —</S></Line>
            <Line at={v + 4}><S>  rotate() now retires the token before the first await;</S></Line>
            <Line at={v + 8}><S>  the three new tests fail against the old code.</S> <Blink /></Line>
        </Term>
    );
};

export const DeskScreen: React.FC = () => (
    <Cross states={[
        { at: 0, el: <DeskWork /> },
        { at: starts.fix, el: <DeskTests /> },
        { at: starts.wall, el: <DeskWall /> },
        { at: deskAck, el: <DeskRun /> },
    ]} />
);

// ----------------------------------------------------------------- phone
// Set in the app's design system: black chrome, #1a1a1a surfaces, #212121
// chips and cards, hairline #2e2e2e dividers, IBM Plex, neutral agent tiles.

const Mic: React.FC<{ c: string }> = ({ c }) => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round">
        <rect x="9" y="3" width="6" height="11" rx="3" />
        <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
    </svg>
);

const HomeBar: React.FC = () => (
    <div style={{ alignSelf: 'center', width: 132, height: 4, borderRadius: 2, background: '#3a3a3e', margin: '0 0 8px' }} />
);

const Glyph: React.FC<{ letter: string; size?: number }> = ({ letter, size = 32 }) => (
    <div style={{
        width: size, height: size, borderRadius: Math.max(6, size * 0.28), flexShrink: 0,
        background: APP.high, border: `1px solid ${APP.divider}`,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontFamily: SANS, fontWeight: 600, fontSize: size * 0.42, color: APP.sub,
    }}>{letter}</div>
);

const SectionTitle: React.FC<{ children: string }> = ({ children }) => (
    <div style={{
        fontFamily: SANS, fontSize: 13, fontWeight: 600, letterSpacing: '0.02em',
        textTransform: 'uppercase', color: APP.section, padding: '18px 16px 6px',
    }}>{children}</div>
);

const Card: React.FC<{ children: React.ReactNode; style?: React.CSSProperties }> = ({ children, style }) => (
    <div style={{
        margin: '10px 12px 0', background: APP.high, borderRadius: 14,
        border: `1px solid ${APP.divider}`, overflow: 'hidden', ...style,
    }}>{children}</div>
);

const PhoneChrome: React.FC<{ children: React.ReactNode; input: string }> = ({ children, input }) => (
    <div style={{ position: 'absolute', inset: 0, background: APP.bg, display: 'flex', flexDirection: 'column' }}>
        <div style={{
            height: 52, display: 'flex', alignItems: 'center', gap: 10, padding: '0 16px',
            flexShrink: 0, background: APP.surface,
        }}>
            <span style={{ color: APP.text, fontSize: 22, lineHeight: '22px' }}>‹</span>
            <span style={{ width: 8, height: 8, borderRadius: 4, background: GREEN }} />
            <span style={{ fontFamily: SANS, fontWeight: 600, fontSize: 15, color: APP.text }}>auth-fix</span>
            <span style={{ marginLeft: 'auto', color: APP.sub, fontSize: 18, letterSpacing: 2 }}>⋯</span>
        </div>
        <div style={{
            padding: '0 14px 8px', flexShrink: 0, background: APP.surface,
            borderBottom: `1px solid ${APP.divider}`, display: 'flex',
        }}>
            <span style={{
                fontFamily: MONO, fontSize: 12, color: APP.sub, background: APP.high,
                borderRadius: 999, padding: '4px 12px',
            }}>⎇ /var/tmp/muxr-demo</span>
        </div>
        <div style={{ flex: 1, position: 'relative', background: APP.termBg, marginBottom: 8 }}>
            {children}
        </div>
        <div style={{ display: 'flex', gap: 6, padding: '0 12px 8px', flexShrink: 0 }}>
            {['tab', 'esc', '^C', '↵', '←', '↑', '↓', '→'].map((k) => (
                <span key={k} style={{
                    fontFamily: MONO, fontSize: 12, color: APP.text, background: APP.high,
                    borderRadius: 12, padding: '7px 0', flex: 1, textAlign: 'center',
                }}>{k}</span>
            ))}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '0 12px 10px', flexShrink: 0 }}>
            <div style={{
                flex: 1, height: 46, borderRadius: 23, background: APP.high,
                display: 'flex', alignItems: 'center', padding: '0 14px 0 18px', gap: 8,
            }}>
                <span style={{ fontFamily: SANS, fontSize: 15, color: '#8E8E93', flex: 1 }}>{input}</span>
                <Mic c="#8E8E93" />
            </div>
        </div>
        <HomeBar />
    </div>
);

const PTerm: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <div style={{
        position: 'absolute', inset: 0, padding: '14px 16px',
        display: 'flex', flexDirection: 'column', justifyContent: 'flex-end',
        fontFamily: MONO, fontSize: 16, lineHeight: '24px', color: '#E0E0E0',
    }}>{children}</div>
);

/** The Yes row on the phone, in panel pixels — where the ripple lands. */
export const TAP = { x: 100, y: 662 };

const PhonePrompt: React.FC<{ tapAt: number }> = ({ tapAt }) => {
    const frame = useCurrentFrame();
    const a = starts.moves + 10;
    const yesIn = interpolate(frame, [a + 18, a + 23], [0, 1], clamp);
    const flash = frame < tapAt ? 0 : interpolate(frame, [tapAt, tapAt + 4, tapAt + 30], [0, 1, 0], clamp);
    return (
        <PTerm>
            <Line at={a}><S>● </S><S>Bash</S><S c={DIM}>(pnpm test)</S></Line>
            <Line at={a + 4}><S c={DIM}>  ⎿  Run the test suite</S></Line>
            <Line at={a + 8} />
            <Line at={a + 10}><S>This command requires approval</S></Line>
            <Line at={a + 14} />
            <Line at={a + 16}><S>Do you want to proceed?</S></Line>
            <div style={{
                whiteSpace: 'pre', borderRadius: 6, margin: '0 -6px', padding: '0 6px',
                opacity: yesIn,
                background: `rgba(48,209,88,${(0.18 * flash).toFixed(3)})`,
            }}>
                <S c={GREEN}>❯ 1. Yes</S>
            </div>
            <Line at={a + 20}><S c={DIM}>  2. Yes, and don't ask again</S></Line>
            <Line at={a + 24}><S c={DIM}>  3. No</S></Line>
            <Line at={a + 28} />
            <Line at={a + 30}><S c={FAINT}>Esc to cancel · Tab to amend</S> <Blink /></Line>
        </PTerm>
    );
};

const PhoneRun: React.FC = () => {
    const a = deskAck + 6;
    const r = runAt;
    const v = starts.result + 10;
    return (
        <PTerm>
            <Line at={a}><S>● </S><S>Bash</S><S c={DIM}>(pnpm test)</S></Line>
            <Line at={a + 4}><S c={GREEN}>  ⎿  </S><S c={DIM}>$ pnpm test</S></Line>
            <Line at={a + 10} />
            <Line at={a + 14}><S c={BLU}> RUN </S><S c={DIM}> v3.2.4</S></Line>
            <Line at={a + 20} />
            <Line at={r + 46}><S c={GREEN}> ✓ </S><S>token-store </S><S c={DIM}>(9) 84ms</S></Line>
            <Line at={r + 132}><S c={GREEN}> ✓ </S><S>session </S><S c={DIM}>(17) 312ms</S></Line>
            <Line at={r + 150} />
            <Line at={r + 176}><S c={DIM}> Tests  </S><S c={GREEN}>26 passed</S><S c={DIM}> (26)</S></Line>
            <Line at={r + 196} />
            <Line at={v}><S>● The refresh-token race is</S></Line>
            <Line at={v + 3}><S>  fixed. rotate() retires the</S></Line>
            <Line at={v + 6}><S>  token before the first await;</S></Line>
            <Line at={v + 9}><S>  the three new tests fail</S></Line>
            <Line at={v + 12}><S>  against the old code.</S> <Blink /></Line>
        </PTerm>
    );
};

// ------------------------------------------------------------ phone: herd

const AGENTS: Array<{ name: string; agent: string; dot: string }> = [
    { name: 'auth-fix', agent: 'claude', dot: APP.done },
    { name: 'billing-refactor', agent: 'codex', dot: APP.working },
    { name: 'flaky-e2e', agent: 'cursor', dot: APP.blocked },
    { name: 'landing-copy', agent: 'gemini', dot: APP.idle },
];

const AgentRow: React.FC<{ name: string; sub: string; dot: string; first?: boolean }> =
    ({ name, sub, dot, first }) => (
        <div style={{ padding: '0 16px' }}>
            {first === true ? null : <div style={{ height: 1, background: APP.divider, marginLeft: 42 }} />}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, minHeight: 56 }}>
                <Glyph letter={name.charAt(0).toUpperCase()} />
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: 1 }}>
                    <span style={{ fontFamily: SANS, fontWeight: 600, fontSize: 14, color: APP.text }}>{name}</span>
                    <span style={{ fontFamily: SANS, fontSize: 12, color: APP.sub }}>{sub}</span>
                </div>
                <span style={{ width: 7, height: 7, borderRadius: 4, background: dot, flexShrink: 0 }} />
            </div>
        </div>
    );

const PhoneHerd: React.FC = () => {
    const a = starts.herd;
    return (
        <div style={{ position: 'absolute', inset: 0, background: APP.bg, display: 'flex', flexDirection: 'column' }}>
            <div style={{ height: 60, display: 'flex', alignItems: 'center', gap: 10, padding: '0 16px', flexShrink: 0 }}>
                <span style={{ fontFamily: SANS, fontWeight: 600, fontSize: 21, color: APP.text }}>Herd</span>
                <span style={{ width: 7, height: 7, borderRadius: 4, background: GREEN, marginLeft: 4 }} />
                <span style={{ fontFamily: SANS, fontSize: 13, color: GREEN }}>connected</span>
            </div>
            <SectionTitle>Spaces</SectionTitle>
            <Rise at={a + 6}>
            <Card style={{ marginTop: 0 }}>
                <div style={{
                    display: 'flex', alignItems: 'center', gap: 8, padding: '0 16px',
                    minHeight: 48, borderBottom: `1px solid ${APP.divider}`,
                }}>
                    <span style={{ color: APP.chevron, fontSize: 12, width: 16 }}>▾</span>
                    <span style={{ width: 8, height: 8, borderRadius: 4, background: APP.working }} />
                    <span style={{ fontFamily: SANS, fontWeight: 600, fontSize: 15, color: APP.text }}>muxr-demo</span>
                    <span style={{
                        fontFamily: SANS, fontSize: 10, color: APP.sub, background: APP.surface,
                        borderRadius: 5, padding: '2px 6px',
                    }}>feat/auth-fix</span>
                    <span style={{ marginLeft: 'auto', fontFamily: SANS, fontWeight: 600, fontSize: 12, color: APP.sub }}>4 agents</span>
                </div>
                {AGENTS.map((row, i) => (
                    <Rise key={row.name} at={a + 12 + i * 7}>
                        <AgentRow name={row.name} sub={`/var/tmp/muxr-demo · ${row.agent}`}
                            dot={row.dot} first={i === 0} />
                    </Rise>
                ))}
            </Card>
            </Rise>
            {[['landing-site', '1 agent'], ['release-notes', '1 agent']].map(([name, n], i) => (
                <Rise key={name} at={a + 46 + i * 6}>
                    <Card>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 16px', minHeight: 48 }}>
                            <span style={{ color: APP.chevron, fontSize: 12, width: 16 }}>▸</span>
                            <span style={{ width: 8, height: 8, borderRadius: 4, background: APP.idle }} />
                            <span style={{ fontFamily: SANS, fontWeight: 600, fontSize: 15, color: APP.text }}>{name}</span>
                            <span style={{ marginLeft: 'auto', fontFamily: SANS, fontWeight: 600, fontSize: 12, color: APP.sub }}>{n}</span>
                        </div>
                    </Card>
                </Rise>
            ))}
            <div style={{ marginTop: 'auto', display: 'flex', alignItems: 'center', gap: 10, padding: '0 12px 10px' }}>
                <div style={{
                    flex: 1, height: 48, borderRadius: 24, background: '#f2f2f4',
                    display: 'flex', alignItems: 'center', padding: '0 6px 0 18px', gap: 8,
                }}>
                    <span style={{ fontFamily: SANS, fontSize: 15, color: '#8e8e93', flex: 1 }}>Plan, ask, build…</span>
                    <Mic c="#3a3a3e" />
                    <div style={{
                        width: 36, height: 36, borderRadius: 18, background: '#111113',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        color: '#f2f2f4', fontSize: 17,
                    }}>↑</div>
                </div>
            </div>
            <HomeBar />
        </div>
    );
};

// ---------------------------------------------------------- phone: diffs

const DiffRow: React.FC<{ no: string; kind?: 'add' | 'del'; children: string }> = ({ no, kind, children }) => (
    <div style={{
        display: 'flex', fontFamily: MONO, fontSize: 12, lineHeight: '22px',
        background: kind === 'add' ? DIFF.addedBg : kind === 'del' ? DIFF.removedBg : 'transparent',
    }}>
        <span style={{ width: 34, flexShrink: 0, textAlign: 'right', paddingRight: 8, color: DIFF.lineNo }}>{no}</span>
        <span style={{
            whiteSpace: 'pre',
            color: kind === 'add' ? DIFF.addedText : kind === 'del' ? DIFF.removedText : DIFF.context,
        }}>{children}</span>
    </div>
);

const PhoneChanges: React.FC = () => {
    const a = starts.diffs;
    return (
        <div style={{ position: 'absolute', inset: 0, background: APP.bg, display: 'flex', flexDirection: 'column' }}>
            <div style={{
                height: 52, display: 'flex', alignItems: 'center', gap: 10, padding: '0 16px',
                flexShrink: 0, background: APP.surface, borderBottom: `1px solid ${APP.divider}`,
            }}>
                <span style={{ color: APP.text, fontSize: 22, lineHeight: '22px' }}>‹</span>
                <span style={{ fontFamily: SANS, fontWeight: 600, fontSize: 15, color: APP.text }}>Code</span>
            </div>
            <Rise at={a + 4} style={{ padding: '16px 16px 0' }}>
                <div style={{ fontFamily: SANS, fontWeight: 600, fontSize: 20, color: APP.text, lineHeight: '26px' }}>
                    Fix the refresh-token race
                </div>
                <div style={{ fontFamily: SANS, fontSize: 12, color: APP.sub, marginTop: 4 }}>
                    auth-fix · claude · just now
                </div>
            </Rise>
            <Rise at={a + 10} style={{ display: 'flex', gap: 6, padding: '12px 16px 0' }}>
                {['All', 'token-store.ts', 'session.test.ts'].map((tab, i) => (
                    <span key={tab} style={{
                        fontFamily: SANS, fontWeight: 600, fontSize: 12, borderRadius: 10,
                        padding: '5px 12px',
                        background: i === 0 ? APP.text : APP.high,
                        color: i === 0 ? '#17171a' : APP.sub,
                    }}>{tab}</span>
                ))}
            </Rise>
            <Rise at={a + 18} style={{ margin: '12px 12px 0' }}>
                <div style={{ borderRadius: 12, border: `1px solid ${DIFF.outline}`, overflow: 'hidden' }}>
                    <div style={{
                        display: 'flex', alignItems: 'baseline', gap: 8, padding: '9px 12px',
                        background: DIFF.header, borderBottom: `1px solid ${DIFF.outline}`,
                    }}>
                        <span style={{ fontFamily: MONO, fontWeight: 600, fontSize: 12, color: APP.text }}>token-store.ts</span>
                        <span style={{ fontFamily: MONO, fontSize: 11, color: DIFF.lineNo }}>src/auth</span>
                        <span style={{ marginLeft: 'auto', fontFamily: MONO, fontSize: 11 }}>
                            <span style={{ color: DIFF.removedText }}>−2</span>
                            <span style={{ color: DIFF.addedText }}> +4</span>
                        </span>
                    </div>
                    <div style={{
                        fontFamily: MONO, fontSize: 11, color: DIFF.hunkText,
                        background: DIFF.header, padding: '4px 12px',
                    }}>@@ -81,4 +83,6 @@ rotate()</div>
                    <div style={{ padding: '4px 0', background: '#111418' }}>
                        <DiffRow no="81">{'async rotate(refresh) {'}</DiffRow>
                        <DiffRow no="82">{'  const subject = this.subjectOf(refresh);'}</DiffRow>
                        <DiffRow no="83" kind="del">{'- const next = await this.issue(subject);'}</DiffRow>
                        <DiffRow no="84" kind="del">{'- return next;'}</DiffRow>
                        <DiffRow no="83" kind="add">{'+ this.invalidate(refresh);'}</DiffRow>
                        <DiffRow no="84" kind="add">{'+ return this.issue(subject);'}</DiffRow>
                        <DiffRow no="85">{'}'}</DiffRow>
                    </div>
                </div>
            </Rise>
            <Rise at={a + 30} style={{ margin: '10px 12px 0' }}>
                <div style={{ borderRadius: 12, border: `1px solid ${DIFF.outline}`, overflow: 'hidden' }}>
                    <div style={{
                        display: 'flex', alignItems: 'baseline', gap: 8, padding: '9px 12px',
                        background: DIFF.header, borderBottom: `1px solid ${DIFF.outline}`,
                    }}>
                        <span style={{ fontFamily: MONO, fontWeight: 600, fontSize: 12, color: APP.text }}>session.test.ts</span>
                        <span style={{ fontFamily: MONO, fontSize: 11, color: DIFF.lineNo }}>tests/auth</span>
                        <span style={{ marginLeft: 'auto', fontFamily: MONO, fontSize: 11, color: DIFF.addedText }}>+46</span>
                    </div>
                    <div style={{
                        fontFamily: MONO, fontSize: 11, color: DIFF.hunkText,
                        background: DIFF.header, padding: '4px 12px',
                    }}>@@ -204,0 +205,46 @@ describe('rotate')</div>
                    <div style={{ padding: '4px 0', background: '#111418' }}>
                        <DiffRow no="205" kind="add">{"+ it('refuses a second redemption"}</DiffRow>
                        <DiffRow no="" kind="add">{"+    of the same token')"}</DiffRow>
                        <DiffRow no="219" kind="add">{"+ it('lets only one concurrent"}</DiffRow>
                        <DiffRow no="" kind="add">{"+    redemption win')"}</DiffRow>
                        <DiffRow no="236" kind="add">{"+ it('retires the token in the"}</DiffRow>
                        <DiffRow no="" kind="add">{"+    same tick')"}</DiffRow>
                    </div>
                </div>
            </Rise>
            <Rise at={a + 44} style={{ margin: '12px 16px 0', display: 'flex', gap: 10 }}>
                <div style={{
                    flex: 1, height: 44, borderRadius: 12, background: '#32D74B',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontFamily: SANS, fontWeight: 600, fontSize: 15, color: '#fff',
                }}>Approve</div>
                <div style={{
                    flex: 1, height: 44, borderRadius: 12, background: '#2C2C2E',
                    border: '1px solid #38383A',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontFamily: SANS, fontWeight: 600, fontSize: 15, color: '#8E8E93',
                }}>Request changes</div>
            </Rise>
            <div style={{ marginTop: 'auto' }}><HomeBar /></div>
        </div>
    );
};

// ---------------------------------------------------------- phone: inbox

const INBOX: Array<{ name: string; reason: string; color: string; when: string }> = [
    { name: 'auth-fix', reason: 'Waiting · pnpm test needs approval', color: APP.waiting, when: 'now' },
    { name: 'flaky-e2e', reason: 'Blocked · needs a decision', color: '#F48FB1', when: '4m' },
    { name: 'billing-refactor', reason: 'Done · 214 tests passed', color: APP.success, when: '12m' },
];

const InboxRow: React.FC<{ row: typeof INBOX[number]; first?: boolean }> = ({ row, first }) => (
    <div style={{ padding: '0 16px' }}>
        {first === true ? null : <div style={{ height: 1, background: APP.divider, marginLeft: 42 }} />}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minHeight: 60 }}>
            <Glyph letter={row.name.charAt(0).toUpperCase()} />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0, flex: 1 }}>
                <span style={{ fontFamily: SANS, fontWeight: 600, fontSize: 14, color: APP.text }}>{row.name}</span>
                <span style={{ fontFamily: SANS, fontSize: 12, color: row.color }}>● {row.reason}</span>
            </div>
            <span style={{ fontFamily: SANS, fontSize: 12, color: APP.sub, flexShrink: 0 }}>{row.when}</span>
        </div>
    </div>
);

const PhoneInbox: React.FC = () => {
    const a = starts.inbox;
    return (
        <div style={{ position: 'absolute', inset: 0, background: APP.bg, display: 'flex', flexDirection: 'column' }}>
            <div style={{ height: 60, display: 'flex', alignItems: 'center', padding: '0 16px', flexShrink: 0 }}>
                <span style={{ fontFamily: SANS, fontWeight: 600, fontSize: 21, color: APP.text }}>Inbox</span>
                <span style={{
                    marginLeft: 8, fontFamily: SANS, fontWeight: 600, fontSize: 12, color: '#fff',
                    background: APP.working, borderRadius: 9, padding: '1px 7px',
                }}>2</span>
            </div>
            <SectionTitle>Needs you</SectionTitle>
            <Rise at={a + 6}>
            <Card style={{ marginTop: 0 }}>
                {INBOX.slice(0, 2).map((row, i) => (
                    <Rise key={row.name} at={a + 8 + i * 7}>
                        <InboxRow row={row} first={i === 0} />
                    </Rise>
                ))}
            </Card>
            </Rise>
            <SectionTitle>Earlier</SectionTitle>
            <Rise at={a + 26}>
            <Card style={{ marginTop: 0 }}>
                <InboxRow row={INBOX[2]} first />
            </Card>
            </Rise>
            <div style={{ marginTop: 'auto' }}><HomeBar /></div>
        </div>
    );
};

// ---------------------------------------------------------- phone: voice

/** Deterministic pseudo-random in [0,1). */
const rnd = (i: number, salt: number) => {
    const x = Math.sin(i * 127.1 + salt * 311.7) * 43758.5453;
    return x - Math.floor(x);
};

const PhoneVoice: React.FC = () => {
    const frame = useCurrentFrame();
    const a = starts.voice;
    const cx = 201, cy = 300;
    const dots: React.ReactNode[] = [];
    for (let i = 0; i < 130; i += 1) {
        const angle = rnd(i, 1) * Math.PI * 2 + frame * 0.0015;
        const radius = ((rnd(i, 2) + rnd(i, 3)) / 2) * 120;
        const x = cx + Math.cos(angle) * radius * 1.3;
        const y = cy + Math.sin(angle) * radius * 0.85;
        const size = 1.5 + rnd(i, 4) * 3;
        const twinkle = 0.55 + 0.45 * Math.sin(frame / 14 + i * 1.7);
        dots.push(<div key={i} style={{
            position: 'absolute', left: x, top: y, width: size, height: size,
            borderRadius: size, background: '#fff',
            opacity: (0.2 + 0.6 * rnd(i, 5)) * twinkle,
        }} />);
    }
    const turns: Array<{ role: string; text: string; at: number }> = [
        { role: 'you', text: 'What changed while I was out?', at: a + 30 },
        { role: 'muxr', text: 'billing-refactor finished — 214 passed. auth-fix wants to run pnpm test.', at: a + 60 },
        { role: 'you', text: 'Approve it, and have Codex open the PR.', at: a + 130 },
    ];
    return (
        <div style={{ position: 'absolute', inset: 0, background: '#050608', display: 'flex', flexDirection: 'column' }}>
            <div style={{ height: 64, display: 'flex', alignItems: 'center', padding: '0 16px', flexShrink: 0, position: 'relative' }}>
                <div style={{
                    width: 40, height: 40, borderRadius: 20, background: '#202329',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    color: '#f3f4f7', fontSize: 16,
                }}>⌄</div>
                <span style={{
                    position: 'absolute', left: 0, right: 0, textAlign: 'center',
                    fontFamily: SANS, fontWeight: 600, fontSize: 16, color: '#f3f4f7',
                }}>Realtime</span>
            </div>
            <div style={{ position: 'relative', height: 560, flexShrink: 0 }}>
                <div style={{
                    position: 'absolute', left: cx - 70, top: cy - 70, width: 140, height: 140,
                    borderRadius: 70,
                    background: 'radial-gradient(circle, rgba(255,255,255,0.85) 0%, rgba(255,255,255,0.12) 34%, transparent 62%)',
                    filter: 'blur(2px)',
                }} />
                {dots}
                <div style={{
                    position: 'absolute', left: 0, right: 0, top: cy + 190, textAlign: 'center',
                    fontFamily: SANS, fontWeight: 600, fontSize: 22, color: '#f7f8fb',
                    opacity: 0.7 + 0.3 * Math.sin(frame / 24),
                }}>Listening</div>
            </div>
            <div style={{ padding: '0 20px', display: 'flex', flexDirection: 'column', gap: 12 }}>
                {turns.map((turn) => (
                    <Rise key={turn.at} at={turn.at} style={{ display: 'flex', gap: 8 }}>
                        <span style={{
                            fontFamily: MONO, fontSize: 11, lineHeight: '21px', width: 40, flexShrink: 0,
                            color: turn.role === 'muxr' ? '#7f8794' : '#5d636e',
                        }}>{turn.role}</span>
                        <span style={{
                            fontFamily: SANS, fontSize: 15, lineHeight: '21px',
                            color: turn.role === 'muxr' ? '#e9ebf0' : '#9aa1ad',
                        }}>{turn.text}</span>
                    </Rise>
                ))}
            </div>
            <div style={{ marginTop: 'auto' }}><HomeBar /></div>
        </div>
    );
};

// ---------------------------------------------------------- phone: relay

const PhoneRelay: React.FC = () => {
    const a = starts.relay;
    return (
        <div style={{ position: 'absolute', inset: 0, background: APP.bg, display: 'flex', flexDirection: 'column' }}>
            <div style={{
                height: 52, display: 'flex', alignItems: 'center', gap: 10, padding: '0 16px',
                flexShrink: 0, background: APP.surface, borderBottom: `1px solid ${APP.divider}`,
            }}>
                <span style={{ color: APP.text, fontSize: 22, lineHeight: '22px' }}>‹</span>
                <span style={{ fontFamily: SANS, fontWeight: 600, fontSize: 15, color: APP.text }}>Connection</span>
                <span style={{ marginLeft: 'auto', width: 8, height: 8, borderRadius: 4, background: GREEN }} />
            </div>
            <Rise at={a + 4}>
            <Card style={{ background: APP.surface }}>
                <div style={{ padding: '14px 16px' }}>
                    <div style={{ fontFamily: SANS, fontWeight: 600, fontSize: 16, color: APP.text }}>Relay</div>
                    <div style={{ fontFamily: MONO, fontSize: 13, color: APP.sub, marginTop: 4 }}>wss://your-host.ts.net</div>
                    <div style={{ height: 1, background: APP.divider, margin: '12px 0' }} />
                    <div style={{ fontFamily: SANS, fontWeight: 600, fontSize: 16, color: APP.text }}>Versions</div>
                    <div style={{ fontFamily: SANS, fontSize: 13, color: APP.sub, marginTop: 4 }}>app 0.1.13 · host 0.1.13</div>
                </div>
            </Card>
            </Rise>
            <SectionTitle>You run the relay</SectionTitle>
            <Rise at={a + 14}>
            <Card style={{ marginTop: 0, background: APP.surface }}>
                <div style={{ padding: '14px 16px' }}>
                    <div style={{ fontFamily: SANS, fontWeight: 600, fontSize: 16, color: APP.text }}>End-to-end encrypted</div>
                    <div style={{ fontFamily: SANS, fontSize: 13, lineHeight: '19px', color: APP.sub, marginTop: 4 }}>
                        Terminal output, keystrokes and approvals are sealed to your machine key before they leave this phone.
                    </div>
                    <div style={{ fontFamily: SANS, fontWeight: 600, fontSize: 16, color: APP.text, marginTop: 14 }}>Pairing holds the credentials</div>
                    <div style={{ fontFamily: SANS, fontSize: 13, lineHeight: '19px', color: APP.sub, marginTop: 4 }}>
                        Keys and tokens come from the QR grant. There is no shared-key fallback.
                    </div>
                </div>
            </Card>
            </Rise>
            <Rise at={a + 26} style={{ padding: '14px 18px 0' }}>
                <div style={{ fontFamily: SANS, fontSize: 13, lineHeight: '19px', color: APP.sub }}>
                    Use your local network, Tailscale, or your own secure tunnel. Every feature stays available in the open-source self-hosted stack.
                </div>
            </Rise>
            <div style={{ marginTop: 'auto' }}><HomeBar /></div>
        </div>
    );
};

export const PhoneScreen: React.FC<{ tapAt: number }> = ({ tapAt }) => (
    <Cross states={[
        { at: starts.moves, el: <PhoneChrome input="Type a prompt…"><PhonePrompt tapAt={tapAt} /></PhoneChrome> },
        { at: deskAck + 4, el: <PhoneChrome input="Type a prompt…"><PhoneRun /></PhoneChrome> },
        { at: starts.diffs, el: <PhoneChanges /> },
        { at: starts.inbox, el: <PhoneInbox /> },
        { at: starts.voice, el: <PhoneVoice /> },
        { at: starts.herd, el: <PhoneHerd /> },
        { at: starts.relay, el: <PhoneRelay /> },
    ]} />
);
