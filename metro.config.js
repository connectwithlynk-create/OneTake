// Metro configuration.
//
// Expo SDK 55 enables package "exports" resolution by default. With it on,
// Metro resolves @supabase/supabase-js via its exports map to the ESM build
// (dist/index.mjs), which fails under Metro/Hermes with
// "Requiring unknown module \"1910\"". Disabling package exports makes Metro
// fall back to the classic `main` field, so supabase-js resolves to its CJS
// build (dist/index.cjs) which works in React Native. Every dependency in
// this project has a `main`/`module` field, so this fallback is safe here.
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
config.resolver.unstable_enablePackageExports = false;

module.exports = config;
