import React from 'react';
import { interpolate, spring, useCurrentFrame } from 'remotion';
import { FPS, GREEN, MUTED, TOKENS, starts } from './config';
import { MONO, SANS } from './fonts';

// The screens, typeset. Same job, same diff, same numbers as the take —
// but drawn, not filmed: no wraps, no banners, no cut letters.

const TXT = '#d6d6d8';
const DIM = '#87878c';
const FAINT = '#5a5a5f';
const RED = '#ff6b60';
const BLU = '#6cb2ff';

const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;

/** One terminal line fading in at its moment (global frames). */
const Line: React.FC<{ at: number; children?: React.ReactNode }> = ({ at, children }) => {
    const frame = useCurrentFrame();
    const o = interpolate(frame, [at, at + 5], [0, 1], clamp);
    return <div style={{ opacity: o, whiteSpace: 'pre' }}>{children ?? '\u00a0'}</div>;
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

const Mic: React.FC<{ c: string }> = ({ c }) => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round">
        <rect x="9" y="3" width="6" height="11" rx="3" />
        <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
    </svg>
);

const PhoneChrome: React.FC<{ children: React.ReactNode; input: string }> = ({ children, input }) => (
    <div style={{ position: 'absolute', inset: 0, background: '#0b0b0c', display: 'flex', flexDirection: 'column' }}>
        <div style={{
            height: 56, display: 'flex', alignItems: 'center', gap: 10, padding: '0 16px', flexShrink: 0,
        }}>
            <span style={{ color: TXT, fontSize: 22, lineHeight: '22px' }}>‹</span>
            <span style={{ width: 8, height: 8, borderRadius: 4, background: GREEN }} />
            <span style={{ fontFamily: SANS, fontWeight: 600, fontSize: 17, color: '#f2f2f4' }}>auth-fix</span>
            <span style={{ marginLeft: 'auto', color: DIM, fontSize: 18, letterSpacing: 2 }}>⋯</span>
        </div>
        <div style={{ padding: '0 16px 10px', flexShrink: 0 }}>
            <span style={{
                fontFamily: MONO, fontSize: 12, color: DIM, background: '#1a1a1c',
                borderRadius: 8, padding: '4px 10px',
            }}>⎇ /var/tmp/muxr-demo</span>
        </div>
        <div style={{ flex: 1, position: 'relative', background: '#0d0d0e', margin: '0 0 8px' }}>
            {children}
        </div>
        <div style={{ display: 'flex', gap: 6, padding: '0 12px 8px', flexShrink: 0 }}>
            {['tab', 'esc', '^C', '↵', '←', '↑', '↓', '→'].map((k) => (
                <span key={k} style={{
                    fontFamily: MONO, fontSize: 12, color: '#c8c8cc', background: '#1f1f22',
                    borderRadius: 8, padding: '7px 0', flex: 1, textAlign: 'center',
                }}>{k}</span>
            ))}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '0 12px 10px', flexShrink: 0 }}>
            <div style={{
                flex: 1, height: 46, borderRadius: 23, background: '#f2f2f4',
                display: 'flex', alignItems: 'center', padding: '0 8px 0 18px', gap: 8,
            }}>
                <span style={{ fontFamily: SANS, fontSize: 15, color: '#8e8e93', flex: 1 }}>{input}</span>
                <Mic c="#3a3a3e" />
            </div>
        </div>
        <div style={{ alignSelf: 'center', width: 132, height: 4, borderRadius: 2, background: '#3a3a3e', marginBottom: 8 }} />
    </div>
);

const PTerm: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <div style={{
        position: 'absolute', inset: 0, padding: '14px 16px',
        display: 'flex', flexDirection: 'column', justifyContent: 'flex-end',
        fontFamily: MONO, fontSize: 16, lineHeight: '24px', color: TXT,
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

const AGENTS = [
    { name: 'billing-refactor', agent: 'codex', live: true, hue: ['#af52de', '#5e5ce6'] },
    { name: 'landing-copy', agent: 'gemini', live: false, hue: ['#ffd60a', '#ff9f0a'] },
    { name: 'flaky-e2e', agent: 'cursor', live: false, hue: ['#64d2ff', '#0a84ff'] },
    { name: 'auth-fix', agent: 'claude', live: true, hue: ['#ff6482', '#ff375f'] },
];

const PhoneHerd: React.FC = () => {
    const frame = useCurrentFrame();
    const a = starts.herd;
    return (
        <div style={{ position: 'absolute', inset: 0, background: '#0b0b0c', display: 'flex', flexDirection: 'column' }}>
            <div style={{ height: 64, display: 'flex', alignItems: 'center', gap: 10, padding: '0 20px', flexShrink: 0 }}>
                <span style={{ fontFamily: SANS, fontWeight: 600, fontSize: 21, color: '#f2f2f4' }}>Herd</span>
                <span style={{ width: 7, height: 7, borderRadius: 4, background: GREEN, marginLeft: 4 }} />
                <span style={{ fontFamily: SANS, fontSize: 13, color: GREEN }}>connected</span>
            </div>
            <div style={{
                fontFamily: SANS, fontSize: 12, fontWeight: 600, letterSpacing: '0.1em',
                color: DIM, padding: '8px 20px 10px',
            }}>SPACES</div>
            <div style={{ margin: '0 12px', background: '#151517', borderRadius: 20, padding: '4px 0' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px' }}>
                    <span style={{ color: DIM, fontSize: 12 }}>▾</span>
                    <span style={{ width: 7, height: 7, borderRadius: 4, background: GREEN }} />
                    <span style={{ fontFamily: SANS, fontWeight: 600, fontSize: 16, color: '#f2f2f4' }}>muxr-demo</span>
                    <span style={{ marginLeft: 'auto', fontFamily: SANS, fontSize: 13, color: DIM }}>4 agents</span>
                </div>
                {AGENTS.map((row, i) => {
                    const at = a + 8 + i * 7;
                    const p = frame < at ? 0 : spring({ frame: frame - at, fps: FPS, config: TOKENS.motion.object });
                    return (
                        <div key={row.name} style={{
                            display: 'flex', alignItems: 'center', gap: 12, padding: '11px 16px',
                            borderTop: `1px solid ${i === 0 ? 'transparent' : '#232326'}`,
                            opacity: Math.min(1, p * 1.4),
                            transform: `translateY(${(10 * (1 - p)).toFixed(2)}px)`,
                        }}>
                            <div style={{
                                width: 40, height: 40, borderRadius: 20,
                                background: `radial-gradient(circle at 30% 30%, ${row.hue[0]}, ${row.hue[1]})`,
                            }} />
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                                <span style={{ fontFamily: SANS, fontWeight: 600, fontSize: 16, color: '#f2f2f4' }}>{row.name}</span>
                                <span style={{ fontFamily: SANS, fontSize: 13, color: DIM }}>/var/tmp/muxr-demo · {row.agent}</span>
                            </div>
                            <span style={{
                                marginLeft: 'auto', width: 8, height: 8, borderRadius: 4,
                                background: row.live ? GREEN : '#3f3f43',
                            }} />
                        </div>
                    );
                })}
            </div>
            {[['landing-site', '1 agent'], ['release-notes', '1 agent']].map(([name, n], i) => {
                const at = a + 40 + i * 6;
                const p = frame < at ? 0 : spring({ frame: frame - at, fps: FPS, config: TOKENS.motion.object });
                return (
                    <div key={name} style={{
                        margin: '10px 12px 0', background: '#131315', borderRadius: 16,
                        display: 'flex', alignItems: 'center', gap: 10, padding: '13px 16px',
                        opacity: Math.min(1, p * 1.4) * 0.7,
                        transform: `translateY(${(10 * (1 - p)).toFixed(2)}px)`,
                    }}>
                        <span style={{ color: DIM, fontSize: 12 }}>▸</span>
                        <span style={{ width: 7, height: 7, borderRadius: 4, background: '#3f3f43' }} />
                        <span style={{ fontFamily: SANS, fontWeight: 600, fontSize: 15, color: '#c8c8cc' }}>{name}</span>
                        <span style={{ marginLeft: 'auto', fontFamily: SANS, fontSize: 13, color: DIM }}>{n}</span>
                    </div>
                );
            })}
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
            <div style={{ alignSelf: 'center', width: 132, height: 4, borderRadius: 2, background: '#3a3a3e', marginBottom: 8 }} />
        </div>
    );
};

export const PhoneScreen: React.FC<{ tapAt: number }> = ({ tapAt }) => (
    <Cross states={[
        { at: starts.moves, el: <PhoneChrome input="Type a prompt…"><PhonePrompt tapAt={tapAt} /></PhoneChrome> },
        { at: deskAck + 4, el: <PhoneChrome input="Type a prompt…"><PhoneRun /></PhoneChrome> },
        { at: starts.herd, el: <PhoneHerd /> },
    ]} />
);

