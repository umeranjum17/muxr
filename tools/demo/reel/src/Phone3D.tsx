import React, { useCallback, useMemo, useState } from 'react';
import * as THREE from 'three';
import { ContactShadows, RoundedBox } from '@react-three/drei';
import { useThree } from '@react-three/fiber';
import { Video } from '@remotion/media';
import { ThreeCanvas } from '@remotion/three';
import {
    AbsoluteFill,
    interpolate,
    spring,
    useCurrentFrame,
    useRemotionEnvironment,
    useVideoConfig,
} from 'remotion';

/**
 * A plane geometry has square corners, which reads wrong inside a rounded
 * bezel. Build the screen from a rounded-rect shape and renormalise its UVs so
 * the video maps edge to edge.
 */
function roundedRect(width: number, height: number, radius: number) {
    const shape = new THREE.Shape();
    const w = width / 2;
    const h = height / 2;
    const r = Math.min(radius, w, h);
    shape.moveTo(-w + r, -h);
    shape.lineTo(w - r, -h);
    shape.quadraticCurveTo(w, -h, w, -h + r);
    shape.lineTo(w, h - r);
    shape.quadraticCurveTo(w, h, w - r, h);
    shape.lineTo(-w + r, h);
    shape.quadraticCurveTo(-w, h, -w, h - r);
    shape.lineTo(-w, -h + r);
    shape.quadraticCurveTo(-w, -h, -w + r, -h);

    const geometry = new THREE.ShapeGeometry(shape, 32);
    const position = geometry.attributes.position;
    const uv = geometry.attributes.uv;
    for (let i = 0; i < position.count; i += 1) {
        uv.setXY(i, (position.getX(i) + w) / width, (position.getY(i) + h) / height);
    }
    uv.needsUpdate = true;
    return geometry;
}

const SHOT_W = 1080;
const SHOT_H = 2400;
const SCREEN_W = 2.2;
const SCREEN_H = (SCREEN_W * SHOT_H) / SHOT_W;
const BEZEL = 0.075;
const DEPTH = 0.26;

const Handset: React.FC<{ src: string; yaw: number; rise: number }> = ({ src, yaw, rise }) => {
    const screen = useMemo(() => roundedRect(SCREEN_W, SCREEN_H, 0.2), []);
    const frame = useCurrentFrame();
    const { fps } = useVideoConfig();

    // A <video> element only decodes in a live browser, so sampling one gives a
    // black screen in a render. Take frames off the headless decoder instead and
    // paint them onto a canvas the material samples.
    const [surface] = useState(() => {
        const canvas = new OffscreenCanvas(SHOT_W, SHOT_H);
        const context = canvas.getContext('2d')!;
        const texture = new THREE.CanvasTexture(canvas);
        return { context, texture };
    });

    const { invalidate, advance } = useThree();
    const { isRendering } = useRemotionEnvironment();

    const onVideoFrame = useCallback((videoFrame: CanvasImageSource) => {
        surface.context.drawImage(videoFrame, 0, 0, SHOT_W, SHOT_H);
        surface.texture.needsUpdate = true;
        // Frame extraction resolves after the canvas has already drawn this
        // frame, so the scene needs a second pass with the new texture. The
        // timestamp is derived from the Remotion frame, never `performance.now`:
        // frames are rendered across several browser tabs, and a wall clock
        // makes the scene land somewhere different in every one of them.
        if (isRendering) advance((frame / fps) * 1000);
        else invalidate();
    }, [surface, advance, invalidate, isRendering, frame, fps]);

    return (
        <>
            <Video src={src} onVideoFrame={onVideoFrame} muted headless />
            <group rotation={[0.02, yaw, -0.008]} position={[0, rise, 0]}>
                <RoundedBox
                    args={[SCREEN_W + BEZEL * 2, SCREEN_H + BEZEL * 2, DEPTH]}
                    radius={0.26}
                    smoothness={6}
                    creaseAngle={0.5}
                >
                    {/* Anodised, not chrome: with no environment map to reflect,
                        a high-metalness body renders as a black silhouette.
                        Diffuse shading plus clearcoat is what makes it read as
                        an object. */}
                    <meshPhysicalMaterial
                        color="#141417"
                        metalness={0.32}
                        roughness={0.4}
                        clearcoat={1}
                        clearcoatRoughness={0.16}
                        reflectivity={0.55}
                    />
                </RoundedBox>
                <mesh geometry={screen} position={[0, 0, DEPTH / 2 + 0.002]}>
                    <meshBasicMaterial map={surface.texture} toneMapped={false} />
                </mesh>
            </group>
            <ContactShadows
                position={[0, -SCREEN_H / 2 - 0.5, 0]}
                opacity={0.6}
                scale={9}
                blur={2.8}
                far={4}
                resolution={512}
                color="#000000"
            />
        </>
    );
};

export const Phone3D: React.FC<{
    src: string;
    width: number;
    height: number;
    /** Flip the yaw so consecutive shots do not sweep in lockstep. */
    mirror?: boolean;
}> = ({ src, width, height, mirror = false }) => {
    const frame = useCurrentFrame();
    const { fps } = useVideoConfig();

    // Every value below comes from the Remotion frame. Nothing reads the r3f
    // clock — that is wall time, and with concurrent rendering it differs per
    // frame, which shows up as the handset vibrating.
    const entry = spring({ frame, fps, config: { damping: 200, mass: 0.6 }, durationInFrames: 26 });
    const direction = mirror ? -1 : 1;
    const yaw = interpolate(frame, [0, 190], [0.075, -0.05], { extrapolateRight: 'clamp' }) * direction;
    // One slow breath across the shot, small enough to feel like presence
    // rather than motion.
    const rise = Math.sin((frame / fps) * 0.55) * 0.018 + interpolate(entry, [0, 1], [-0.16, 0]);
    const scale = interpolate(entry, [0, 1], [0.985, 1]);
    const opacity = interpolate(entry, [0, 1], [0, 1]);

    return (
        <AbsoluteFill style={{ opacity, transform: `scale(${scale})` }}>
            <ThreeCanvas
                width={width}
                height={height}
                camera={{ fov: 30, position: [0, 0, 11.1] }}
                gl={{ antialias: true, alpha: true }}
                style={{ background: 'transparent' }}
            >
                {/* Neutral light only. The product spends colour on status dots
                    and nothing else, so neither does the art. */}
                <ambientLight intensity={0.95} />
                <directionalLight position={[5, 7, 9]} intensity={3.1} color="#ffffff" />
                <directionalLight position={[-7, 3, 5]} intensity={1.5} color="#d6d6da" />
                <directionalLight position={[-2, -5, 7]} intensity={0.9} color="#bfbfc6" />
                <pointLight position={[3.4, 1.2, 3.2]} intensity={30} color="#ffffff" distance={16} decay={2} />
                <Handset src={src} yaw={yaw} rise={rise} />
            </ThreeCanvas>
        </AbsoluteFill>
    );
};
