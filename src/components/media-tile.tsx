import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { ClipVideo } from './clip-video';
import { AppText } from './ui';
import { palette, radius, space } from '../theme';

/**
 * One media tile, used by every clip / media list so they look identical:
 * a rounded portrait video thumbnail with small tag pills overlaid on top,
 * a title and a muted date line underneath. Optional verdict-colored
 * thumbnail border and a discreet corner delete.
 *
 * Grid usage: FlatList numColumns={MEDIA_COLUMNS}, columnWrapperStyle and
 * contentContainerStyle gap = space.md, render <MediaTile .../> per item.
 */
export const MEDIA_COLUMNS = 3;

export function MediaTile({
  uri,
  title,
  date,
  tags = [],
  accent,
  onPress,
  onLongPress,
  onDelete,
}: {
  uri: string;
  title: string;
  date: string;
  tags?: string[];
  accent?: string;
  onPress?: () => void;
  onLongPress?: () => void;
  onDelete?: () => void;
}) {
  return (
    <Pressable
      style={styles.cell}
      onPress={onPress}
      onLongPress={
        onLongPress
          ? () => {
              Haptics.selectionAsync().catch(() => {});
              onLongPress();
            }
          : undefined
      }
      delayLongPress={250}
    >
      <View
        style={[
          styles.thumb,
          accent ? { borderColor: accent, borderWidth: 2 } : null,
        ]}
      >
        <ClipVideo uri={uri} style={StyleSheet.absoluteFill} />

        {tags.length > 0 && (
          <View style={styles.tagRow}>
            {tags.slice(0, 2).map((t) => (
              <View key={t} style={styles.tag}>
                <AppText kind="caption" style={styles.tagText} numberOfLines={1}>
                  {t}
                </AppText>
              </View>
            ))}
          </View>
        )}

        {onDelete && (
          <Pressable style={styles.del} onPress={onDelete} hitSlop={8}>
            <Ionicons name="trash" size={13} color="#fff" />
          </Pressable>
        )}
      </View>

      <AppText kind="body" numberOfLines={1} style={styles.title}>
        {title}
      </AppText>
      <AppText kind="caption" numberOfLines={1} style={styles.date}>
        {date}
      </AppText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  cell: { flex: 1, maxWidth: `${100 / MEDIA_COLUMNS - 2}%` },
  thumb: {
    aspectRatio: 3 / 4,
    borderRadius: radius.md,
    overflow: 'hidden',
    backgroundColor: '#111',
    borderWidth: 1,
    borderColor: palette.border,
  },
  tagRow: {
    position: 'absolute',
    top: 6,
    left: 6,
    right: 6,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 4,
  },
  tag: {
    backgroundColor: 'rgba(0,0,0,0.55)',
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 999,
    maxWidth: '100%',
  },
  tagText: { color: '#fff', fontSize: 10, letterSpacing: 0.3 },
  del: {
    position: 'absolute',
    bottom: 6,
    right: 6,
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: 'rgba(0,0,0,0.5)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: { marginTop: space.sm },
  date: { color: palette.textFaint, marginTop: 1 },
});
