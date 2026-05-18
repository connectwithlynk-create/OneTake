import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams } from 'expo-router';
import React, { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';

import {
  AppText,
  Button,
  EmptyState,
  Header,
  Loading,
  Screen,
} from '@/components/ui';
import {
  deleteInspiration,
  fileInspiration,
  getCollection,
  listUnfiled,
} from '@/lib/repo';
import { invalidate, useData } from '@/lib/store';
import { palette, radius, space } from '@/theme';
import type { Inspiration } from '@/lib/types';

const THRESHOLD = 120;

export default function SwipeScreen() {
  const { collectionId } = useLocalSearchParams<{ collectionId: string }>();
  const { data: col } = useData(() => getCollection(collectionId), [collectionId]);
  const { data: initial } = useData(listUnfiled);

  const [cards, setCards] = useState<Inspiration[] | null>(null);
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (initial && cards === null) setCards(initial);
  }, [initial, cards]);

  // Refresh other screens' counts when leaving.
  useEffect(() => () => invalidate(), []);

  const x = useSharedValue(0);
  const y = useSharedValue(0);

  function commit(dir: number) {
    const item = cards?.[index];
    if (item) {
      if (dir > 0) fileInspiration(item.id, collectionId);
      else deleteInspiration(item.id);
    }
    x.value = 0;
    y.value = 0;
    setIndex((i) => i + 1);
  }

  const pan = Gesture.Pan()
    .onUpdate((e) => {
      x.value = e.translationX;
      y.value = e.translationY;
    })
    .onEnd((e) => {
      if (Math.abs(e.translationX) > THRESHOLD) {
        const dir = e.translationX > 0 ? 1 : -1;
        x.value = withTiming(dir * 700, { duration: 220 }, (done) => {
          if (done) runOnJS(commit)(dir);
        });
      } else {
        x.value = withSpring(0);
        y.value = withSpring(0);
      }
    });

  const frontStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: x.value },
      { translateY: y.value },
      { rotate: `${x.value / 22}deg` },
    ],
  }));
  const saveStyle = useAnimatedStyle(() => ({ opacity: x.value > 40 ? 1 : 0 }));
  const nopeStyle = useAnimatedStyle(() => ({ opacity: x.value < -40 ? 1 : 0 }));

  if (!col || cards === null) return <Screen><Loading /></Screen>;

  const remaining = cards.length - index;
  const current = cards[index];
  const next = cards[index + 1];

  return (
    <Screen>
      <Header title={`Into "${col.name}"`} back />
      <AppText kind="dim" style={{ marginBottom: space.lg }}>
        Swipe right to save into this collection. Swipe left to discard.
      </AppText>

      {remaining <= 0 || !current ? (
        <EmptyState
          icon="checkmark-done"
          title="All sorted"
          subtitle="No more unfiled reels. Nice."
        />
      ) : (
        <View style={{ flex: 1 }}>
          <View style={styles.deck}>
            {next && (
              <View style={[styles.card, { backgroundColor: next.thumb_color, transform: [{ scale: 0.94 }] }]} />
            )}
            <GestureDetector gesture={pan}>
              <Animated.View
                style={[styles.card, { backgroundColor: current.thumb_color }, frontStyle]}
              >
                <Animated.View style={[styles.badge, styles.save, saveStyle]}>
                  <AppText kind="subtitle" style={{ color: palette.onBright }}>
                    SAVE
                  </AppText>
                </Animated.View>
                <Animated.View style={[styles.badge, styles.nope, nopeStyle]}>
                  <AppText kind="subtitle" style={{ color: '#fff' }}>
                    NOPE
                  </AppText>
                </Animated.View>

                <View style={{ flex: 1, justifyContent: 'flex-end' }}>
                  <Ionicons name="play-circle" size={40} color={palette.onBright} />
                  <AppText
                    kind="subtitle"
                    numberOfLines={2}
                    style={{ color: palette.onBright, marginTop: space.sm }}
                  >
                    {current.note || current.source_url}
                  </AppText>
                </View>
              </Animated.View>
            </GestureDetector>
          </View>

          <View style={{ flexDirection: 'row', gap: space.lg, marginTop: space.xl }}>
            <View style={{ flex: 1 }}>
              <Button label="Discard" tone="danger" icon="close" onPress={() => commit(-1)} />
            </View>
            <View style={{ flex: 1 }}>
              <Button label="Save" tone="accent" icon="heart" onPress={() => commit(1)} />
            </View>
          </View>
          <AppText kind="caption" style={{ textAlign: 'center', marginTop: space.lg }}>
            {remaining} LEFT
          </AppText>
        </View>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  deck: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  card: {
    position: 'absolute',
    width: '100%',
    height: '92%',
    borderRadius: radius.xl,
    padding: space.xl,
  },
  badge: {
    position: 'absolute',
    top: space.xl,
    paddingVertical: space.sm,
    paddingHorizontal: space.lg,
    borderRadius: radius.md,
    borderWidth: 3,
  },
  save: { right: space.xl, borderColor: palette.onBright, transform: [{ rotate: '14deg' }] },
  nope: { left: space.xl, borderColor: '#fff', transform: [{ rotate: '-14deg' }] },
});
