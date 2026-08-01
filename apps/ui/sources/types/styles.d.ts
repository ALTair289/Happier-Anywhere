// Expo generates an ignored expo-env.d.ts locally, but CI typechecks a fresh checkout
// before that file exists. Keep stylesheet side-effect imports part of the app's tracked contract.
declare module '*.css';
