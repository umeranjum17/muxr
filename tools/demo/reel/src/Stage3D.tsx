import React, { useCallback, useMemo, useState } from 'react';
import * as THREE from 'three';
import { ContactShadows, MeshReflectorMaterial, RoundedBox } from '@react-three/drei';
import { useThree } from '@react-three/fiber';
import { Video } from '@remotion/media';
import { ThreeCanvas } from '@remotion/three';
import {
    interpolate,
    useCurrentFrame,
    useRemotionEnvironment,
    useVideoConfig,
} from 'remotion';

/**
 * The 3D stage the whole film is shot on: a handset standing on a dark mirror
 * under a studio light, and a camera that moves.
 *
 * One rule governs everything here — nothing may read the r3f clock. Frames are
 * rendered concurrently across browser tabs whose clocks start at different
 * instants, so any wall-time animation lands somewhere different in every frame
 * and the result vibrates. Every value below comes from `useCurrentFrame()`.
 */

const SHOT_W = 1080;
const SHOT_H = 2400;
const SCREEN_W = 2.2;
const SCREEN_H = (SCREEN_W * SHOT_H) / SHOT_W;
const BEZEL = 0.075;
const DEPTH = 0.26;
const FLOOR_Y = -SCREEN_H / 2 - 0.36;

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

/**
 * A softbox rig, painted rather than downloaded. drei's <Environment preset>
 * fetches an HDR from a CDN, which a repo pipeline should not depend on; an
 * equirect gradient with two bright panels run through PMREM gives the body and
 * the floor something real to reflect, offline and deterministically.
 */
function useStudioEnvironment() {
    const { gl, scene } = useThree();
    useMemo(() => {
        const canvas = new OffscreenCanvas(1024, 512);
        const ctx = canvas.getContext('2d')!;
        const sky = ctx.createLinearGradient(0, 0, 0, 512);
        sky.addColorStop(0, '#4a4a54');
        sky.addColorStop(0.42, '#17171c');
        sky.addColorStop(1, '#060607');
        ctx.fillStyle = sky;
        ctx.fillRect(0, 0, 1024, 512);

        const softbox = (x: number, y: number, w: number, h: number, alpha: number) => {
            const g = ctx.createRadialGradient(x + w / 2, y + h / 2, 0, x + w / 2, y + h / 2, Math.max(w, h) / 2);
            g.addColorStop(0, `rgba(255,255,255,${alpha})`);
            g.addColorStop(1, 'rgba(255,255,255,0)');
            ctx.fillStyle = g;
            ctx.fillRect(x, y, w, h);
        };
        softbox(90, 30, 300, 210, 0.95);   // key, camera left and high
        softbox(640, 70, 210, 150, 0.5);   // fill, opposite side
        softbox(430, 250, 160, 110, 0.22); // a low bounce so the bezel base is not dead

        const equirect = new THREE.CanvasTexture(canvas);
        equirect.mapping = THREE.EquirectangularReflectionMapping;
        equirect.colorSpace = THREE.SRGBColorSpace;

        const pmrem = new THREE.PMREMGenerator(gl);
        pmrem.compileEquirectangularShader();
        scene.environment = pmrem.fromEquirectangular(equirect).texture;
        equirect.dispose();
        pmrem.dispose();
        return null;
    }, [gl, scene]);
}

/** One screen: a headless decoder painting into a canvas the material samples. */
function useScreen(src: string | undefined) {
    const [surface] = useState(() => {
        const canvas = new OffscreenCanvas(SHOT_W, SHOT_H);
        const context = canvas.getContext('2d')!;
        const texture = new THREE.CanvasTexture(canvas);
        texture.colorSpace = THREE.SRGBColorSpace;
        return { context, texture };
    });

    const { invalidate, advance } = useThree();
    const { isRendering } = useRemotionEnvironment();
    const frame = useCurrentFrame();
    const { fps } = useVideoConfig();

    const onVideoFrame = useCallback((videoFrame: CanvasImageSource) => {
        surface.context.drawImage(videoFrame, 0, 0, SHOT_W, SHOT_H);
        surface.texture.needsUpdate = true;
        // Frame extraction resolves after the scene has already drawn, so it
        // needs a second pass. The timestamp is frame-derived, never wall time.
        if (isRendering) advance((frame / fps) * 1000);
        else invalidate();
    }, [surface, advance, invalidate, isRendering, frame, fps]);

    return {
        texture: surface.texture,
        node: src === undefined
            ? null
            : <Video src={src} onVideoFrame={onVideoFrame} muted headless />,
    };
}

/**
 * A mirror large enough to avoid a visible far edge still meets the sky
 * somewhere, and that meeting draws a hard horizon across the shot. Lay an ink
 * sheet over it that is transparent under the handset and opaque outward, and
 * the reflection becomes a pool rather than a floor.
 */
const FloorFade: React.FC = () => {
    const texture = useMemo(() => {
        const canvas = new OffscreenCanvas(512, 512);
        const ctx = canvas.getContext('2d')!;
        const g = ctx.createRadialGradient(256, 256, 0, 256, 256, 256);
        g.addColorStop(0, 'rgba(10,10,11,0)');
        g.addColorStop(0.42, 'rgba(10,10,11,0.35)');
        g.addColorStop(0.72, 'rgba(10,10,11,0.94)');
        g.addColorStop(1, 'rgba(10,10,11,1)');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, 512, 512);
        const tex = new THREE.CanvasTexture(canvas);
        tex.colorSpace = THREE.SRGBColorSpace;
        return tex;
    }, []);

    return (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, FLOOR_Y + 0.004, 0]}>
            <planeGeometry args={[240, 240]} />
            <meshBasicMaterial map={texture} transparent depthWrite={false} toneMapped={false} />
        </mesh>
    );
};

const Floor: React.FC = () => (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, FLOOR_Y, 0]}>
        <planeGeometry args={[240, 240]} />
        {/* The mirror is what turns a floating rectangle into an object standing
            somewhere. Blurred hard and mixed low, so it reads as polished ink
            rather than a swimming pool — and made huge, because a plane whose
            far edge lands inside the frustum draws a hard horizon across the
            shot. */}
        <MeshReflectorMaterial
            resolution={1024}
            blur={[900, 300]}
            mixBlur={1}
            mixStrength={1.15}
            mirror={0.3}
            depthScale={1.1}
            minDepthThreshold={0.4}
            maxDepthThreshold={1.25}
            color="#08080a"
            metalness={0.55}
            roughness={0.92}
        />
    </mesh>
);

const Handset: React.FC<{
    front: THREE.Texture;
    back: THREE.Texture | null;
    spin: number;
    lean: number;
    lift: number;
}> = ({ front, back, spin, lean, lift }) => {
    const screen = useMemo(() => roundedRect(SCREEN_W, SCREEN_H, 0.2), []);

    return (
        <group rotation={[lean, spin, -0.006]} position={[0, lift, 0]}>
            <RoundedBox
                args={[SCREEN_W + BEZEL * 2, SCREEN_H + BEZEL * 2, DEPTH]}
                radius={0.26}
                smoothness={6}
                creaseAngle={0.5}
            >
                <meshPhysicalMaterial
                    color="#141417"
                    metalness={0.55}
                    roughness={0.32}
                    clearcoat={1}
                    clearcoatRoughness={0.12}
                    envMapIntensity={1.35}
                />
            </RoundedBox>
            <mesh geometry={screen} position={[0, 0, DEPTH / 2 + 0.002]}>
                <meshBasicMaterial map={front} toneMapped={false} />
            </mesh>
            {/* The other theme lives on the back of the same object, so the flip
                is one handset turning over rather than two clips crossfading. */}
            {back === null ? null : (
                <mesh geometry={screen} position={[0, 0, -DEPTH / 2 - 0.002]} rotation={[0, Math.PI, 0]}>
                    <meshBasicMaterial map={back} toneMapped={false} />
                </mesh>
            )}
        </group>
    );
};

export type CameraKey = 'push' | 'close' | 'flip' | 'orbit' | 'tilt';

/** Where the camera is, and what it looks at, as a function of shot progress. */
function framing(kind: CameraKey, t: number) {
    switch (kind) {
        case 'close':
            // Start wide on the whole handset and end on the top of the screen,
            // drifting the subject right as it grows so the headline keeps its
            // half of the frame instead of being run over.
            return {
                position: [
                    interpolate(t, [0, 1], [0.35, 0.05]),
                    interpolate(t, [0, 1], [0, 1.1]),
                    interpolate(t, [0, 1], [11.6, 6.9]),
                ] as [number, number, number],
                target: [
                    interpolate(t, [0, 1], [0, -0.62]),
                    interpolate(t, [0, 1], [0, 1.15]),
                    0,
                ] as [number, number, number],
            };
        case 'orbit':
            return {
                position: [
                    Math.sin(interpolate(t, [0, 1], [-0.34, 0.24])) * 11.6,
                    interpolate(t, [0, 1], [0.9, -0.15]),
                    Math.cos(interpolate(t, [0, 1], [-0.34, 0.24])) * 11.6,
                ] as [number, number, number],
                target: [0, 0, 0] as [number, number, number],
            };
        case 'tilt':
            return {
                position: [0, interpolate(t, [0, 1], [2.6, 1.4]), interpolate(t, [0, 1], [10.2, 11.2])] as [number, number, number],
                target: [0, interpolate(t, [0, 1], [0.5, 0]), 0] as [number, number, number],
            };
        case 'flip':
            // Hold still and let the object do the moving. Framed right of
            // centre throughout so the headline keeps the left of the frame.
            return {
                position: [0, 0.15, interpolate(t, [0, 1], [11.6, 10.9])] as [number, number, number],
                target: [interpolate(t, [0, 1], [-0.55, -0.78]), 0, 0] as [number, number, number],
            };
        case 'push':
        default:
            return {
                position: [
                    interpolate(t, [0, 1], [-0.35, 0.3]),
                    interpolate(t, [0, 1], [0.35, -0.1]),
                    interpolate(t, [0, 1], [12.1, 10.9]),
                ] as [number, number, number],
                target: [0, 0, 0] as [number, number, number],
            };
    }
}

const Rig: React.FC<{ kind: CameraKey; t: number }> = ({ kind, t }) => {
    const { camera } = useThree();
    const { position, target } = framing(kind, t);
    camera.position.set(position[0], position[1], position[2]);
    camera.lookAt(target[0], target[1], target[2]);
    camera.updateMatrixWorld();
    return null;
};

const Scene: React.FC<{
    frontSrc: string;
    backSrc?: string;
    kind: CameraKey;
    t: number;
    spin: number;
    lean: number;
    lift: number;
}> = ({ frontSrc, backSrc, kind, t, spin, lean, lift }) => {
    useStudioEnvironment();
    const front = useScreen(frontSrc);
    const back = useScreen(backSrc);

    return (
        <>
            {front.node}
            {back.node}
            <Rig kind={kind} t={t} />
            {/* The environment does most of the work; these three place the
                highlights the eye reads as edges. */}
            <ambientLight intensity={0.5} />
            <directionalLight position={[5.5, 7.5, 8]} intensity={2.1} color="#ffffff" />
            <directionalLight position={[-7, 2.5, 5]} intensity={0.9} color="#d8d8dd" />
            <pointLight position={[3.2, 1.4, 3.4]} intensity={22} color="#ffffff" distance={16} decay={2} />
            <Floor />
            <FloorFade />
            <Handset front={front.texture} back={backSrc === undefined ? null : back.texture} spin={spin} lean={lean} lift={lift} />
            <ContactShadows
                position={[0, FLOOR_Y + 0.01, 0]}
                opacity={0.7}
                scale={11}
                blur={2.6}
                far={4.5}
                resolution={512}
                color="#000000"
            />
        </>
    );
};

export const Stage3D: React.FC<{
    frontSrc: string;
    backSrc?: string;
    kind?: CameraKey;
    width: number;
    height: number;
    /** 0..1 through the shot, so the camera move is independent of shot length. */
    t: number;
    spin?: number;
    lean?: number;
    lift?: number;
}> = ({ frontSrc, backSrc, kind = 'push', width, height, t, spin = 0, lean = 0.015, lift = 0 }) => (
    <ThreeCanvas
        width={width}
        height={height}
        camera={{ fov: 30, position: [0, 0, 11.2] }}
        gl={{ antialias: true, alpha: true }}
        style={{ background: 'transparent' }}
    >
        <Scene frontSrc={frontSrc} backSrc={backSrc} kind={kind} t={t} spin={spin} lean={lean} lift={lift} />
    </ThreeCanvas>
);
