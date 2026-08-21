import { Config } from '@remotion/cli/config';

Config.setVideoImageFormat('jpeg');
Config.setCodec('h264');
Config.setCrf(21);
Config.setPixelFormat('yuv420p');
Config.setChromiumOpenGlRenderer('angle-egl');
Config.overrideWebpackConfig((current) => ({
    ...current,
    resolve: {
        ...current.resolve,
        extensionAlias: { '.js': ['.ts', '.tsx', '.js'] },
    },
}));
