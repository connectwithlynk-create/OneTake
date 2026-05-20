import { requireNativeView } from 'expo';
import * as React from 'react';

import { NlePlayer } from './NlePlayerModule';
import { NlePlayerViewProps } from './NlePlayer.types';

const NativeView: React.ComponentType<NlePlayerViewProps> =
  requireNativeView('NlePlayer');

/** Renders a native surface bound to a specific NlePlayer instance. */
export default function NlePlayerView({
  player,
  style,
}: {
  player: NlePlayer;
  style?: NlePlayerViewProps['style'];
}) {
  return <NativeView playerHandle={player.handle} style={style} />;
}
