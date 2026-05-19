import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useVideoPlayer, VideoView } from 'expo-video';
import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppText } from '@/components/ui';
import { resolveClipUri } from '@/lib/filestore';
import { space } from '@/theme';

/** Full-screen clip player with sound + native controls. Opened by tapping
 *  any clip tile. */
export default function PlayerScreen() {
  const { uri, title } = useLocalSearchParams<{
    uri?: string;
    title?: string;
  }>();
  const router = useRouter();

  const player = useVideoPlayer(uri ? resolveClipUri(uri) : null, (p) => {
    p.loop = true;
    p.play();
  });

  return (
    <View style={styles.root}>
      {uri ? (
        <VideoView
          player={player}
          style={StyleSheet.absoluteFill}
          nativeControls
          contentFit="contain"
        />
      ) : (
        <View style={[StyleSheet.absoluteFill, styles.center]}>
          <AppText kind="dim">Clip unavailable.</AppText>
        </View>
      )}

      <SafeAreaView edges={['top']} style={styles.bar}>
        <Pressable style={styles.close} onPress={() => router.back()}>
          <Ionicons name="close" size={22} color="#fff" />
        </Pressable>
        {title ? (
          <AppText
            kind="subtitle"
            numberOfLines={1}
            style={{ color: '#fff', flex: 1 }}
          >
            {title}
          </AppText>
        ) : null}
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  center: { alignItems: 'center', justifyContent: 'center' },
  bar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingTop: space.sm,
  },
  close: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(0,0,0,0.5)',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
