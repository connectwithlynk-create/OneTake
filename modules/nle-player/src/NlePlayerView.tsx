import { requireNativeView } from 'expo';
import * as React from 'react';
import { View } from 'react-native';

import { isNlePlayerAvailable, NlePlayer } from './NlePlayerModule';
import { NlePlayerViewProps } from './NlePlayer.types';

const NativeView: React.ComponentType<NlePlayerViewProps> =
  isNlePlayerAvailable
    ? requireNativeView('NlePlayer')
    : ({ style }) => <View style={style} />;

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
