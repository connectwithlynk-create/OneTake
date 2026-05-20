import { useLocalSearchParams } from 'expo-router';
import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';

import {
  Button,
  EmptyState,
  Header,
  Loading,
  MediaPlaceholder,
  MonoLabel,
  Screen,
} from '@/components/ui';
import {
  deleteInspiration,
  fileInspiration,
  getCollection,
  listUnfiled,
} from '@/lib/repo';
import { invalidate, useData } from '@/lib/store';
import type { Inspiration } from '@/lib/types';
import { font, palette } from '@/theme';

const THRESHOLD = 120;

const TINTS = ['lime', 'magenta', 'cool', 'gold', 'violet', 'warm'] as const;

export default function SwipeScreen() {
  const { collectionId } = useLocalSearchParams<{ collectionId: string }>();
  const { data: col } = useData(() => getCollection(collectionId), [collectionId]);
  const { data: initial } = useData(listUnfiled);

  const [cards, setCards] = useState<Inspiration[] | null>(null);
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (initial && cards === null) setCards(initial);
  }, [initial, cards]);

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
  const currentTint = TINTS[index % TINTS.length];
  const nextTint = TINTS[(index + 1) % TINTS.length];

  return (
    <Screen pad={false}>
      <Header title={`Into "${col.name}"`} back />
      <Text style={s.intro}>
        Swipe right to save into this collection. Swipe left to discard.
      </Text>

      {remaining <= 0 || !current ? (
        <EmptyState
          icon="checkmark-done"
          title="All sorted"
          subtitle="No more unfiled reels. Nice."
        />
      ) : (
        <View style={{ flex: 1, paddingHorizontal: 18 }}>
          <View style={s.deck}>
            {/* back cards */}
            <View style={[s.cardBack, s.cardBack3]} />
            <View style={[s.cardBack, s.cardBack2]} />

            {/* middle card */}
            {next && (
              <View style={s.cardMid}>
                <MediaPlaceholder variant={nextTint} />
              </View>
            )}

            <GestureDetector gesture={pan}>
              <Animated.View style={[s.cardFront, frontStyle]}>
                <MediaPlaceholder
                  variant={currentTint}
                  label={current.note ?? current.source_url}
                />

                <View style={s.cardOverlay} pointerEvents="none">
                  <View style={s.cardTopRow}>
                    <View style={s.creatorAvatar} />
                    <View style={{ flex: 1 }}>
                      <Text style={s.creator} numberOfLines={1}>
                        {hostFor(current.source_url)}
                      </Text>
                      <Text style={s.creatorSub} numberOfLines={1}>
                        {col.name} · saved
                      </Text>
                    </View>
                    <View style={s.durChip}>
                      <Text style={s.durChipText}>0:18</Text>
                    </View>
                  </View>

                  {current.note ? (
                    <View style={s.tagRow}>
                      <View style={s.styleTag}>
                        <Text style={s.styleTagText}>{current.note}</Text>
                      </View>
                    </View>
                  ) : null}
                </View>

                <Animated.View style={[s.badge, s.saveBadge, saveStyle]}>
                  <Text style={[s.badgeText, { color: palette.lime }]}>SAVE</Text>
                </Animated.View>
                <Animated.View style={[s.badge, s.nopeBadge, nopeStyle]}>
                  <Text style={[s.badgeText, { color: palette.coral }]}>NOPE</Text>
                </Animated.View>
              </Animated.View>
            </GestureDetector>
          </View>

          <View style={s.actions}>
            <View style={{ flex: 1 }}>
              <Button
                label="Discard"
                tone="danger"
                icon="close"
                full
                onPress={() => commit(-1)}
              />
            </View>
            <View style={{ flex: 1 }}>
              <Button
                label="Save"
                icon="heart"
                full
                onPress={() => commit(1)}
              />
            </View>
          </View>
          <MonoLabel style={{ textAlign: 'center', marginTop: 20 }}>
            {remaining} LEFT
          </MonoLabel>
        </View>
      )}
    </Screen>
  );
}

function hostFor(url: string): string {
  try {
    const { hostname } = new URL(url);
    return `@${hostname.replace(/^www\./, '').split('.')[0]}`;
  } catch {
    return '@unknown';
  }
}

const s = StyleSheet.create({
  intro: {
    paddingHorizontal: 22,
    paddingBottom: 18,
    fontFamily: font.body,
    fontSize: 13,
    color: palette.text2,
  },
  deck: { flex: 1, position: 'relative', marginBottom: 8 },
  cardBack: {
    position: 'absolute',
    borderRadius: 24,
    backgroundColor: 'rgba(20,24,42,1)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
  },
  cardBack3: {
    top: 20,
    left: 24,
    right: 24,
    bottom: 0,
    opacity: 0.6,
    transform: [{ rotate: '-2deg' }],
  },
  cardBack2: {
    top: 12,
    left: 16,
    right: 16,
    bottom: 0,
    opacity: 0.85,
    transform: [{ rotate: '2deg' }],
  },
  cardMid: {
    position: 'absolute',
    top: 6,
    left: 10,
    right: 10,
    bottom: 0,
    borderRadius: 26,
    overflow: 'hidden',
    opacity: 0.88,
    transform: [{ rotate: '1deg' }],
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
  },
  cardFront: {
    position: 'absolute',
    inset: 0 as any,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    borderRadius: 28,
    overflow: 'hidden',
    backgroundColor: palette.bg2,
    shadowColor: '#000',
    shadowOpacity: 0.5,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 20 },
    elevation: 12,
  },
  cardOverlay: {
    ...StyleSheet.absoluteFillObject,
    padding: 14,
    justifyContent: 'space-between',
  },
  cardTopRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  creatorAvatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: palette.coral,
    borderWidth: 2,
    borderColor: '#fff',
  },
  creator: {
    fontFamily: font.bodyBold,
    fontSize: 13,
    fontWeight: '700',
    color: '#fff',
  },
  creatorSub: {
    fontFamily: font.body,
    fontSize: 11,
    color: 'rgba(255,255,255,0.8)',
  },
  durChip: {
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 6,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  durChipText: {
    fontFamily: font.monoBold,
    fontSize: 10,
    color: palette.lime,
    fontWeight: '700',
  },
  tagRow: { flexDirection: 'row', gap: 6, flexWrap: 'wrap' },
  styleTag: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 999,
    backgroundColor: 'rgba(0,0,0,0.5)',
    borderWidth: 1,
    borderColor: `${palette.lime}66`,
  },
  styleTagText: {
    fontFamily: font.bodyBold,
    fontSize: 10,
    fontWeight: '700',
    color: palette.lime,
  },
  badge: {
    position: 'absolute',
    top: 80,
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 8,
    borderWidth: 3,
    backgroundColor: 'rgba(8,8,15,0.55)',
  },
  saveBadge: { right: 20, borderColor: palette.lime, transform: [{ rotate: '14deg' }] },
  nopeBadge: { left: 20, borderColor: palette.coral, transform: [{ rotate: '-14deg' }] },
  badgeText: {
    fontFamily: font.displayHeavy,
    fontWeight: '800',
    fontSize: 22,
    letterSpacing: 1,
  },
  actions: { flexDirection: 'row', gap: 12, marginTop: 20 },
});
