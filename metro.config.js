// Metro configuration.
//
// Keep package "exports" resolution ENABLED (Expo SDK 55 default). @clerk/expo
// imports subpaths like "@clerk/react/internal" / "@clerk/react/errors" that
// exist only via exports maps - disabling exports globally breaks Clerk.
//
// @supabase/supabase-js's exports map points the "import" condition at an ESM
// (.mjs) bundle that crashes under Metro/Hermes ("Requiring unknown module
// 1910"). So surgically redirect just that one package to its CJS build and
// leave every other package on Expo's default resolver.
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

const supabaseCjs = require.resolve('@supabase/supabase-js/dist/index.cjs');
const defaultResolveRequest = config.resolver.resolveRequest;

config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === '@supabase/supabase-js') {
    return { type: 'sourceFile', filePath: supabaseCjs };
  }
  const next = defaultResolveRequest ?? context.resolveRequest;
  return next(context, moduleName, platform);
};

module.exports = config;
