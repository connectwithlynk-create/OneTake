import { useVideoPlayer, VideoView } from 'expo-video';
import React from 'react';
import { StyleProp, ViewStyle } from 'react-native';

import { resolveClipUri } from '@/lib/filestore';

/**
 * Inline clip video. Default = paused first frame (cheap poster for lists).
 * autoplay = muted looping preview (capture review). Each instance owns its
 * own player, so it is safe to render many in a list.
 */
export function ClipVideo({
  uri,
  style,
  autoplay = false,
}: {
  uri: string;
  style?: StyleProp<ViewStyle>;
  autoplay?: boolean;
}) {
  const player = useVideoPlayer(resolveClipUri(uri), (p) => {
    p.muted = true;
    p.loop = true;
    if (autoplay) p.play();
  });

  return (
    <VideoView
      player={player}
      style={style}
      nativeControls={false}
      contentFit="cover"
    />
  );
}
