import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';
import React, { useCallback } from 'react';
import {
  FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import {
  Button,
  EmptyState,
  Loading,
  MonoLabel,
  Screen,
  StatusPill,
} from '@/components/ui';
import { listProjects } from '@/lib/repo';
import { invalidate, useData } from '@/lib/store';
import { relativeAge } from '@/lib/time';
import type { Project } from '@/lib/types';
import { font, palette } from '@/theme';

const CHAPTERS = [
  {
    icon: 'sparkles' as const,
    kicker: 'CHAPTER 01',
    title: 'Think it.',
    body: 'Swipe in a vibe. Save reels into collections and teach Clipnosis the pacing, hooks, captions, and energy you want.',
    color: palette.lime,
  },
  {
    icon: 'desktop-outline' as const,
    kicker: 'CHAPTER 02',
    title: 'See it.',
    body: 'Your keepers fly into Studio, where the timeline assembles itself with trims, b-roll drops, captions, and audio beats.',
    color: palette.magenta,
  },
  {
    icon: 'phone-portrait-outline' as const,
    kicker: 'CHAPTER 03',
    title: 'Ship it.',
    body: 'The finished 1080x1920 reel lands back on your phone with captions burned in and the share sheet ready.',
    color: palette.cyan,
  },
];

const HUD = [
  { label: 'SCORE', value: '12,450', color: palette.lime },
  { label: 'STREAK', value: '12', color: palette.magenta },
  { label: 'COMBO', value: 'x1.5', color: palette.gold },
];

const HIGH_SCORES = [
  { value: '0.8s', label: 'Verdict latency', color: palette.lime },
  { value: '82%', label: 'Keeper rate', color: palette.magenta },
  { value: '38s', label: 'Auto-edit loop', color: palette.cyan },
  { value: '100%', label: 'On-device capture', color: palette.gold },
];

const TICKER = [
  '@mia.k hit a 12-day streak',
  '@gym.gremlin auto-edited 38s in 27s',
  '@taro.lifts hit a PERFECT take',
];

export default function ProjectsScreen() {
  const router = useRouter();
  const { data: projects, loading } = useData(listProjects);

  useFocusEffect(
    useCallback(() => {
      invalidate();
    }, [])
  );

  const projectData = projects ?? [];

  return (
    <Screen pad={false}>
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={s.page}
      >
        <LandingHero
          onStart={() => router.push('/new-project')}
          onCamera={() => router.push('/camera')}
        />

        <View style={s.ticker}>
          {TICKER.map((item) => (
            <View key={item} style={s.tickerItem}>
              <View style={s.tickerDot} />
              <Text style={s.tickerText}>{item}</Text>
            </View>
          ))}
        </View>

        <View style={s.chapterGrid}>
          {CHAPTERS.map((item) => (
            <ChapterCard key={item.title} {...item} />
          ))}
        </View>

        <Scoreboard />

        <View style={s.sectionHead}>
          <View>
            <MonoLabel>WORKSPACE</MonoLabel>
            <Text style={s.sectionTitle}>Your projects</Text>
          </View>
          <Pressable
            style={({ pressed }) => [
              s.newMini,
              { opacity: pressed ? 0.75 : 1 },
            ]}
            onPress={() => router.push('/new-project')}
          >
            <Ionicons name="add" size={14} color={palette.onBright} />
            <Text style={s.newMiniText}>NEW</Text>
          </Pressable>
        </View>

        {loading && !projects ? (
          <Loading />
        ) : projectData.length === 0 ? (
          <EmptyState
            icon="scan"
            title="No projects yet"
            subtitle="Start a clip read or capture a take. Clipnosis keeps the workspace local until you finish."
          />
        ) : (
          <FlatList
            key="projects-grid"
            data={projectData}
            keyExtractor={(p) => p.id}
            numColumns={2}
            scrollEnabled={false}
            columnWrapperStyle={{ gap: 12 }}
            contentContainerStyle={{ gap: 12 }}
            renderItem={({ item, index }) => (
              <ProjectCard
                item={item}
                index={index}
                onPress={() =>
                  router.push({
                    pathname: '/project/[id]',
                    params: { id: item.id },
                  })
                }
              />
            )}
          />
        )}
      </ScrollView>
    </Screen>
  );
}

function LandingHero({
  onStart,
  onCamera,
}: {
  onStart: () => void;
  onCamera: () => void;
}) {
  return (
    <View style={s.hero}>
      <View style={s.heroTop}>
        <ClipnosisMark />
        <View style={s.hudStack}>
          {HUD.map((item) => (
            <View key={item.label} style={s.hudPill}>
              <Text style={s.hudLabel}>{item.label}</Text>
              <Text style={[s.hudValue, { color: item.color }]}>{item.value}</Text>
            </View>
          ))}
        </View>
      </View>

      <View style={s.heroBody}>
        <View style={s.copy}>
          <MonoLabel color={palette.lime}>SHORT-FORM / IOS BETA</MonoLabel>
          <View style={s.slogan}>
            <Text style={[s.sloganLine, { color: palette.lime }]}>Think it.</Text>
            <Text style={[s.sloganLine, { color: palette.magenta }]}>See it.</Text>
            <Text style={[s.sloganLine, { color: palette.cyan }]}>Ship it.</Text>
          </View>
          <Text style={s.lede}>
            Clipnosis grades every take on your phone. Your keepers fly to the
            desktop Studio and cut themselves, then the finished reel lands back
            in your pocket.
          </Text>
          <View style={s.actions}>
            <Button
              label="Start clip read"
              icon="scan"
              size="lg"
              onPress={onStart}
            />
            <Button
              label="Watch the loop"
              icon="play"
              tone="ghost"
              size="lg"
              onPress={onCamera}
            />
          </View>
          <View style={s.metaRow}>
            <Text style={s.metaBadge}>VERDICT IN 0.8S</Text>
            <Text style={s.metaBadge}>FREE WHILE IN BETA</Text>
          </View>
        </View>

        <DeviceStage />
      </View>
    </View>
  );
}

function ClipnosisMark() {
  return (
    <View style={s.mark}>
      <View style={s.markGlyph}>
        <View style={s.markCore} />
        <View style={s.markRing} />
      </View>
      <Text style={s.markText}>Clipnosis</Text>
    </View>
  );
}

function DeviceStage() {
  return (
    <View style={s.stage}>
      <View style={s.xferIdea}>
        <Text style={s.xferText}>IDEA</Text>
      </View>
      <View style={s.xferVideo}>
        <Ionicons name="play" size={9} color={palette.onBright} />
        <Text style={s.xferVideoText}>REEL.mp4</Text>
      </View>

      <View style={s.phone}>
        <View style={s.notch} />
        <View style={s.phoneGlow} />
        <View style={s.phoneTop}>
          <View>
            <Text style={s.phoneTitle}>Hey, Rahul.</Text>
            <Text style={s.phoneMeta}>Tue 14 / 12 day streak</Text>
          </View>
          <View style={s.recBadge}>
            <View style={s.recDot} />
            <Text style={s.recText}>LIVE</Text>
          </View>
        </View>

        <View style={s.statsGrid}>
          <MiniStat value="147" label="CLIPS" color={palette.lime} />
          <MiniStat value="12" label="PROJECTS" color={palette.magenta} />
          <MiniStat value="82%" label="KEEPERS" color={palette.gold} />
        </View>

        <View style={s.recentLabel}>
          <Text style={s.recentText}>RECENT CLIPS</Text>
        </View>
        <View style={s.clipGrid}>
          {['PERFECT', 'KEEP', 'DUD', 'PERFECT', 'KEEP', 'KEEP'].map((v, i) => (
            <View
              key={`${v}-${i}`}
              style={[
                s.clipTile,
                {
                  backgroundColor:
                    i % 3 === 0
                      ? `${palette.lime}18`
                      : i % 3 === 1
                        ? `${palette.cyan}18`
                        : `${palette.magenta}18`,
                },
              ]}
            >
              <Text
                style={[
                  s.clipVerdict,
                  {
                    color:
                      v === 'PERFECT'
                        ? palette.lime
                        : v === 'KEEP'
                          ? palette.cyan
                          : palette.coral,
                  },
                ]}
              >
                {v}
              </Text>
            </View>
          ))}
        </View>
      </View>

      <View style={s.desktop}>
        <View style={s.desktopTop}>
          <View style={s.desktopBrandDot} />
          <Text style={s.desktopTitle}>Clipnosis Studio</Text>
          <Text style={s.desktopExport}>Send to Phone</Text>
        </View>
        <View style={s.desktopBody}>
          <View style={s.mediaBin}>
            {[palette.lime, palette.lime, palette.cyan, palette.coral].map((c, i) => (
              <View key={`${c}-${i}`} style={s.binClip}>
                <View style={[s.binDot, { backgroundColor: c }]} />
              </View>
            ))}
          </View>
          <View style={s.editorPreview}>
            <View style={s.videoFrame}>
              <View style={s.scanLine} />
              <View style={s.face}>
                <View style={s.faceDot} />
              </View>
              <View style={s.captionRail}>
                <Text style={s.captionText}>5AM HIT DIFFERENT</Text>
              </View>
            </View>
          </View>
        </View>
        <View style={s.timeline}>
          {([
            [palette.lime, '2%', '24%'],
            [palette.lime, '30%', '20%'],
            [palette.cyan, '56%', '16%'],
            [palette.magenta, '74%', '20%'],
          ] as const).map(([color, left, width], i) => (
            <View
              key={`${color}-${i}`}
              style={[
                s.timelineClip,
                { backgroundColor: `${color}66`, borderColor: color, left, width },
              ]}
            />
          ))}
          <View style={s.playhead} />
        </View>
      </View>
    </View>
  );
}

function MiniStat({
  value,
  label,
  color,
}: {
  value: string;
  label: string;
  color: string;
}) {
  return (
    <View style={s.miniStat}>
      <Text style={[s.miniStatValue, { color }]}>{value}</Text>
      <Text style={s.miniStatLabel}>{label}</Text>
    </View>
  );
}

function Scoreboard() {
  return (
    <View style={s.scoreboard}>
      <View style={s.scoreHead}>
        <MonoLabel color={palette.lime}>HIGH SCORES</MonoLabel>
        <Text style={s.scoreTitle}>The numbers behind the loop.</Text>
      </View>
      <View style={s.scoreGrid}>
        {HIGH_SCORES.map((item) => (
          <View key={item.label} style={s.scoreCell}>
            <Text style={[s.scoreValue, { color: item.color }]}>{item.value}</Text>
            <Text style={s.scoreLabel}>{item.label}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

function ChapterCard({
  icon,
  kicker,
  title,
  body,
  color,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  kicker: string;
  title: string;
  body: string;
  color: string;
}) {
  return (
    <View style={[s.chapter, { borderColor: `${color}44` }]}>
      <View style={s.chapterTop}>
        <Text style={[s.chapterKicker, { color }]}>{kicker}</Text>
        <View style={[s.chapterIcon, { backgroundColor: `${color}18` }]}>
        <Ionicons name={icon} size={18} color={color} />
        </View>
      </View>
      <Text style={[s.chapterTitle, { color }]}>{title}</Text>
      <Text style={s.chapterBody}>{body}</Text>
    </View>
  );
}

const TILE_TINT: Record<string, string> = {
  lime: palette.lime,
  cyan: palette.cyan,
  magenta: palette.magenta,
  gold: palette.gold,
  violet: palette.violet,
  coral: palette.coral,
};
const TINT_ORDER = ['lime', 'magenta', 'cyan', 'gold', 'violet', 'coral'] as const;

function ProjectCard({
  item,
  onPress,
  index,
}: {
  item: Project;
  onPress: () => void;
  index: number;
}) {
  const tint = TILE_TINT[TINT_ORDER[index % TINT_ORDER.length]];
  return (
    <Pressable style={s.card} onPress={onPress}>
      <View
        style={[
          s.thumb,
          {
            backgroundColor: `${tint}10`,
            borderColor: `${tint}22`,
          },
        ]}
      >
        <View style={s.thumbInner}>
          <Ionicons
            name={item.type === 'prompt' ? 'sparkles' : 'film'}
            size={36}
            color={`${tint}66`}
          />
        </View>
        <View style={s.statusOverlay}>
          <StatusPill s={item.status} />
        </View>
        <View style={s.play}>
          <Ionicons name="play" size={11} color="#fff" />
        </View>
      </View>
      <View style={s.info}>
        <Text style={s.title} numberOfLines={1}>
          {item.title}
        </Text>
        <Text style={s.meta} numberOfLines={1}>
          {item.type === 'prompt' ? 'Prompt' : 'Talking-head'} /{' '}
          {relativeAge(item.created_at)}
        </Text>
      </View>
    </Pressable>
  );
}

const s = StyleSheet.create({
  page: {
    paddingHorizontal: 18,
    paddingBottom: 140,
    gap: 16,
  },
  hero: {
    marginTop: 8,
    padding: 18,
    borderRadius: 24,
    backgroundColor: palette.bg1,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.09)',
    overflow: 'hidden',
  },
  heroTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 18,
    gap: 12,
  },
  mark: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  markGlyph: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: `${palette.lime}18`,
    borderWidth: 1,
    borderColor: `${palette.lime}55`,
    alignItems: 'center',
    justifyContent: 'center',
  },
  markCore: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: palette.lime,
  },
  markRing: {
    position: 'absolute',
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: `${palette.cyan}88`,
  },
  markText: {
    fontFamily: font.displayHeavy,
    fontWeight: '800',
    fontSize: 25,
    lineHeight: 26,
    color: '#fff',
  },
  hudStack: {
    alignItems: 'flex-end',
    gap: 5,
  },
  hudPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 9,
    paddingVertical: 5,
    borderRadius: 10,
    backgroundColor: 'rgba(255,255,255,0.055)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
  },
  hudLabel: {
    fontFamily: font.monoBold,
    fontSize: 8.5,
    fontWeight: '700',
    letterSpacing: 0.9,
    color: palette.text3,
  },
  hudValue: {
    fontFamily: font.monoBold,
    fontSize: 10.5,
    fontWeight: '700',
  },
  livePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
  },
  liveDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: palette.lime,
  },
  liveText: {
    fontFamily: font.monoBold,
    fontSize: 10,
    fontWeight: '700',
    color: palette.text2,
    letterSpacing: 0.8,
  },
  heroBody: { gap: 18 },
  copy: { gap: 12 },
  slogan: {
    gap: 0,
  },
  sloganLine: {
    fontFamily: font.displayHeavy,
    fontWeight: '800',
    fontSize: 48,
    lineHeight: 43,
    textTransform: 'uppercase',
    textShadowColor: 'rgba(199,247,60,0.25)',
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 18,
  },
  h1: {
    maxWidth: 620,
    fontFamily: font.displayHeavy,
    fontWeight: '800',
    fontSize: 42,
    lineHeight: 40,
    color: '#fff',
  },
  lede: {
    maxWidth: 620,
    fontFamily: font.body,
    fontSize: 15,
    lineHeight: 22,
    color: palette.text2,
  },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    marginTop: 4,
  },
  metaRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 4,
  },
  metaBadge: {
    fontFamily: font.monoBold,
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1,
    color: palette.text3,
    paddingHorizontal: 9,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.045)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
  },
  stage: {
    minHeight: 430,
    position: 'relative',
    justifyContent: 'center',
  },
  xferIdea: {
    position: 'absolute',
    top: 76,
    left: 20,
    zIndex: 4,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: palette.lime,
    shadowColor: palette.lime,
    shadowOpacity: 0.45,
    shadowRadius: 18,
  },
  xferText: {
    fontFamily: font.monoBold,
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 1,
    color: palette.onBright,
  },
  xferVideo: {
    position: 'absolute',
    right: 18,
    bottom: 64,
    zIndex: 4,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 9,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: palette.cyan,
    shadowColor: palette.cyan,
    shadowOpacity: 0.38,
    shadowRadius: 18,
  },
  xferVideoText: {
    fontFamily: font.monoBold,
    fontSize: 8.5,
    fontWeight: '700',
    color: palette.onBright,
  },
  phone: {
    width: '62%',
    minHeight: 330,
    padding: 14,
    borderRadius: 30,
    backgroundColor: '#08080F',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.14)',
    overflow: 'hidden',
    transform: [{ rotateY: '-12deg' }, { rotateX: '4deg' }],
    shadowColor: palette.lime,
    shadowOpacity: 0.22,
    shadowRadius: 28,
  },
  notch: {
    position: 'absolute',
    top: 10,
    alignSelf: 'center',
    width: 68,
    height: 18,
    borderRadius: 999,
    backgroundColor: '#000',
    zIndex: 2,
  },
  phoneGlow: {
    position: 'absolute',
    top: -110,
    right: -70,
    width: 210,
    height: 210,
    borderRadius: 110,
    backgroundColor: `${palette.lime}20`,
  },
  phoneTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  phoneTitle: {
    fontFamily: font.bodyBold,
    fontWeight: '700',
    fontSize: 15,
    color: '#fff',
  },
  phoneMeta: {
    marginTop: 2,
    fontFamily: font.mono,
    fontSize: 10,
    color: palette.text3,
  },
  recBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 9,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: `${palette.coral}18`,
  },
  recDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: palette.coral,
  },
  recText: {
    fontFamily: font.monoBold,
    fontSize: 10,
    fontWeight: '700',
    color: palette.coral,
  },
  statsGrid: {
    flexDirection: 'row',
    gap: 5,
    marginTop: 2,
  },
  miniStat: {
    flex: 1,
    padding: 7,
    borderRadius: 10,
    backgroundColor: 'rgba(255,255,255,0.045)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
  },
  miniStatValue: {
    fontFamily: font.displayHeavy,
    fontSize: 16,
    fontWeight: '800',
  },
  miniStatLabel: {
    marginTop: 1,
    fontFamily: font.monoBold,
    fontSize: 7,
    fontWeight: '700',
    letterSpacing: 0.8,
    color: palette.text3,
  },
  recentLabel: {
    marginTop: 10,
  },
  recentText: {
    fontFamily: font.monoBold,
    fontSize: 8.5,
    fontWeight: '700',
    letterSpacing: 1.2,
    color: palette.text3,
  },
  clipGrid: {
    marginTop: 7,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 5,
  },
  clipTile: {
    width: '31.5%',
    aspectRatio: 9 / 14,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.07)',
    padding: 4,
    justifyContent: 'flex-start',
  },
  clipVerdict: {
    fontFamily: font.monoBold,
    fontSize: 6.5,
    fontWeight: '700',
    letterSpacing: 0.4,
    paddingHorizontal: 3,
    paddingVertical: 2,
    borderRadius: 3,
    backgroundColor: 'rgba(0,0,0,0.58)',
    alignSelf: 'flex-start',
  },
  desktop: {
    position: 'absolute',
    right: 0,
    top: 82,
    width: '70%',
    minHeight: 226,
    borderRadius: 18,
    backgroundColor: '#0A0A12',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.13)',
    overflow: 'hidden',
    transform: [{ rotateY: '-12deg' }, { rotateX: '4deg' }],
    shadowColor: palette.magenta,
    shadowOpacity: 0.24,
    shadowRadius: 28,
  },
  desktopTop: {
    minHeight: 30,
    paddingHorizontal: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.07)',
  },
  desktopBrandDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: palette.magenta,
  },
  desktopTitle: {
    flex: 1,
    fontFamily: font.monoBold,
    fontSize: 8,
    fontWeight: '700',
    letterSpacing: 0.5,
    color: '#fff',
  },
  desktopExport: {
    fontFamily: font.displayHeavy,
    fontSize: 8,
    fontWeight: '800',
    color: palette.onBright,
    backgroundColor: palette.magenta,
    paddingHorizontal: 7,
    paddingVertical: 4,
    borderRadius: 999,
  },
  desktopBody: {
    flexDirection: 'row',
    flex: 1,
    minHeight: 132,
  },
  mediaBin: {
    width: 48,
    padding: 6,
    gap: 5,
    borderRightWidth: 1,
    borderRightColor: 'rgba(255,255,255,0.07)',
  },
  binClip: {
    height: 22,
    borderRadius: 5,
    backgroundColor: 'rgba(255,255,255,0.055)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
  },
  binDot: {
    position: 'absolute',
    top: 3,
    right: 3,
    width: 5,
    height: 5,
    borderRadius: 3,
  },
  editorPreview: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.025)',
  },
  videoFrame: {
    width: 68,
    height: 116,
    borderRadius: 10,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: `${palette.magenta}16`,
    borderWidth: 1,
    borderColor: `${palette.magenta}88`,
  },
  timeline: {
    height: 60,
    margin: 8,
    borderRadius: 10,
    backgroundColor: 'rgba(0,0,0,0.32)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.07)',
    position: 'relative',
    overflow: 'hidden',
  },
  timelineClip: {
    position: 'absolute',
    top: 20,
    height: 18,
    borderRadius: 5,
    borderWidth: 1,
  },
  playhead: {
    position: 'absolute',
    top: 7,
    bottom: 7,
    left: '51%',
    width: 2,
    backgroundColor: '#fff',
    opacity: 0.85,
  },
  preview: {
    height: 170,
    borderRadius: 18,
    backgroundColor: palette.bg2,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  scanLine: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 62,
    height: 2,
    backgroundColor: palette.lime,
    opacity: 0.85,
  },
  face: {
    width: 86,
    height: 112,
    borderRadius: 42,
    backgroundColor: `${palette.magenta}20`,
    borderWidth: 1,
    borderColor: `${palette.magenta}55`,
    alignItems: 'center',
    justifyContent: 'center',
  },
  faceDot: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: `${palette.lime}80`,
  },
  captionRail: {
    position: 'absolute',
    bottom: 14,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 999,
    backgroundColor: 'rgba(0,0,0,0.65)',
  },
  captionText: {
    fontFamily: font.displayHeavy,
    fontSize: 13,
    fontWeight: '800',
    color: '#fff',
  },
  verdictRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 10,
  },
  chip: {
    flex: 1,
    minHeight: 34,
    borderRadius: 999,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
  },
  chipText: {
    fontFamily: font.monoBold,
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.7,
  },
  flowList: {
    marginTop: 12,
    borderRadius: 16,
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.07)',
    overflow: 'hidden',
  },
  flowRow: {
    minHeight: 42,
    paddingHorizontal: 12,
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.06)',
  },
  flowMark: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 8,
  },
  flowLabel: {
    flex: 1,
    fontFamily: font.bodyBold,
    fontSize: 12.5,
    fontWeight: '700',
    color: '#fff',
  },
  flowValue: {
    fontFamily: font.monoBold,
    fontSize: 11,
    fontWeight: '700',
  },
  ticker: {
    paddingVertical: 11,
    paddingHorizontal: 12,
    borderRadius: 16,
    backgroundColor: 'rgba(255,255,255,0.045)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    gap: 8,
  },
  tickerItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  tickerDot: {
    width: 5,
    height: 5,
    borderRadius: 3,
    backgroundColor: palette.lime,
  },
  tickerText: {
    fontFamily: font.mono,
    fontSize: 11,
    color: palette.text2,
  },
  chapterGrid: {
    gap: 10,
  },
  chapter: {
    padding: 15,
    borderRadius: 18,
    backgroundColor: palette.bg1,
    borderWidth: 1,
  },
  chapterTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  chapterKicker: {
    fontFamily: font.monoBold,
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1.4,
  },
  chapterIcon: {
    width: 38,
    height: 38,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chapterTitle: {
    fontFamily: font.displayHeavy,
    fontWeight: '800',
    fontSize: 30,
    lineHeight: 31,
    textTransform: 'uppercase',
  },
  chapterBody: {
    marginTop: 6,
    fontFamily: font.body,
    fontSize: 13,
    lineHeight: 18,
    color: palette.text2,
  },
  scoreboard: {
    padding: 16,
    borderRadius: 22,
    backgroundColor: 'rgba(199,247,60,0.045)',
    borderWidth: 1,
    borderColor: `${palette.lime}55`,
  },
  scoreHead: {
    gap: 6,
    marginBottom: 14,
  },
  scoreTitle: {
    fontFamily: font.displayHeavy,
    fontSize: 28,
    lineHeight: 29,
    fontWeight: '800',
    color: '#fff',
  },
  scoreGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  scoreCell: {
    width: '48%',
    padding: 12,
    borderRadius: 14,
    backgroundColor: 'rgba(0,0,0,0.28)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.07)',
  },
  scoreValue: {
    fontFamily: font.displayHeavy,
    fontSize: 31,
    lineHeight: 32,
    fontWeight: '800',
  },
  scoreLabel: {
    marginTop: 5,
    fontFamily: font.mono,
    fontSize: 9.5,
    lineHeight: 13,
    letterSpacing: 0.8,
    color: palette.text3,
  },
  sectionHead: {
    marginTop: 4,
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
  },
  sectionTitle: {
    marginTop: 4,
    fontFamily: font.displayHeavy,
    fontWeight: '800',
    fontSize: 28,
    lineHeight: 30,
    color: '#fff',
  },
  newMini: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: palette.lime,
  },
  newMiniText: {
    fontFamily: font.monoBold,
    fontSize: 11,
    fontWeight: '700',
    color: palette.onBright,
    letterSpacing: 0.6,
  },
  card: {
    flex: 1,
    maxWidth: '48.5%',
    aspectRatio: 9 / 16,
    borderRadius: 18,
    overflow: 'hidden',
    backgroundColor: palette.bg1,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
  },
  thumb: {
    flex: 1,
    borderBottomWidth: 1,
    position: 'relative',
  },
  thumbInner: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  statusOverlay: { position: 'absolute', top: 8, left: 8 },
  play: {
    position: 'absolute',
    bottom: 8,
    right: 8,
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  info: { paddingHorizontal: 12, paddingVertical: 10 },
  title: {
    fontFamily: font.bodyBold,
    fontWeight: '700',
    fontSize: 13,
    color: '#fff',
  },
  meta: {
    fontFamily: font.body,
    fontSize: 11,
    color: palette.text3,
    marginTop: 2,
  },
});
